#!/usr/bin/env bun
/**
 * The hook latency budget, measured. The guard and the pre-phase capture run synchronously
 * on EVERY Bash call, so an unmeasured port is how a 60 ms tax becomes a 300 ms one.
 *
 * Read-only: it pipes fixed payloads into the entrypoints and into the guard this port
 * replaces. It writes only under /tmp (source files, scratch git homes under a throwaway
 * `GENESIS_TOOLS_HOME`), never the real `~/.genesis-tools`.
 *
 * Usage: bun scripts/benchmarks/hooks/hook-latency.ts [--runs 20] [--json <path>]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";

const OLD_WRAPPER = join(homedir(), ".claude", "hooks", "announce-hook-bg.sh");
const runsIndex = process.argv.indexOf("--runs");
const RUNS = runsIndex >= 0 ? Number(process.argv[runsIndex + 1]) : 20;

// `--runs 0`, `--runs abc` or a missing value left no samples, and the median of nothing is 0,
// which printed every stage as comfortably within budget.
if (!Number.isInteger(RUNS) || RUNS < 1) {
    out.println(`--runs must be a positive integer, got ${process.argv[runsIndex + 1] ?? "nothing"}`);
    process.exit(1);
}
const jsonIndex = process.argv.indexOf("--json");

/**
 * The budget, revised 2026-09-20 against measured floors. The original `guard: <= 10 ms`
 * predated measuring anything: a bun process floor is 3.3 ms and this module graph is 7.4 ms,
 * so 10 ms was never reachable for a TypeScript entrypoint. `bun build --compile` is a stated
 * non-goal (it saves about 30 ms of 127 ms and has three blockers).
 */
const BUDGET_MS: Record<string, number> = {
    "guard only, no rule matches": 30,
    "guard only, a rule matches": 30,
    "pre phase: guard plus capture": 110,
    "post phase, no change": 30,
};

interface Stage {
    name: string;
    entry: string;
    payload: Record<string, unknown>;
}

const cwd = process.cwd();
const base = { tool_name: "Bash", cwd, session_id: "bench", tool_use_id: "bench-call" };
const STAGES: Stage[] = [
    {
        name: "guard only, no rule matches",
        entry: "src/agents/bin/hook-guard.ts",
        payload: { ...base, hook_event_name: "PreToolUse", tool_input: { command: "git status --porcelain" } },
    },
    {
        name: "guard only, a rule matches",
        entry: "src/agents/bin/hook-guard.ts",
        payload: { ...base, hook_event_name: "PreToolUse", tool_input: { command: 'tsgo | tail -5; echo "exit=$?"' } },
    },
    {
        name: "pre phase: guard plus capture",
        entry: "src/agents/bin/hook-pre.ts",
        payload: { ...base, hook_event_name: "PreToolUse", tool_input: { command: "git status --porcelain" } },
    },
    {
        name: "post phase, no change",
        entry: "src/agents/bin/hook-diff-post.ts",
        payload: {
            ...base,
            hook_event_name: "PostToolUse",
            tool_input: { command: "true" },
            tool_response: { stdout: "" },
        },
    },
];

interface RowResult {
    stage: string;
    ms: number;
    budget: number;
    withinBudget: boolean;
    min?: number;
    max?: number;
    userMs?: number;
    sysMs?: number;
    note?: string;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
}

function timeIt(command: string, args: string[], input: string, env: Record<string, string> = {}): number {
    const values: number[] = [];

    for (let run = 0; run < RUNS + 3; run++) {
        const started = performance.now();

        const child = spawnSync(command, args, {
            input,
            encoding: "utf8",
            maxBuffer: 64_000_000,
            env: { ...process.env, ...env },
        });

        const elapsed = performance.now() - started;

        // An entrypoint that dies at import time exits FAST, so an unchecked failure reported
        // itself as "ok, within budget" and the benchmark exited 0.
        if (child.status !== 0) {
            const why = child.error ?? child.signal ?? `exit ${child.status}`;
            throw new Error(`${command} ${args.join(" ")} failed (${why}): ${String(child.stderr).slice(0, 800)}`);
        }

        // Three warmups, discarded: the first runs pay the filesystem cache.
        if (run >= 3) {
            values.push(elapsed);
        }
    }

    return median(values);
}

const rows: RowResult[] = [];

for (const stage of STAGES) {
    const ms = timeIt("bun", [stage.entry], SafeJSON.stringify(stage.payload));
    const budget = BUDGET_MS[stage.name] ?? Number.POSITIVE_INFINITY;

    rows.push({ stage: stage.name, ms: Number(ms.toFixed(1)), budget, withinBudget: ms <= budget });
}

// `LEGACY_GUARD_AND_DIFF=1` turns the legacy guard and capture back on FOR THIS CALL. After
// the cutover the wrapper is neutered, and without this the reference line timed an empty
// script and still printed a figure that looked fine: 48 ms became 5.9 ms with no warning.
// The wrapper is only a reference line, and a fresh checkout does not have it. Timing it anyway
// now throws (a missing script exits 127), which would cost every measured stage above.
const oldClean = existsSync(OLD_WRAPPER)
    ? timeIt(
          "sh",
          [OLD_WRAPPER],
          SafeJSON.stringify({
              ...base,
              hook_event_name: "PreToolUse",
              tool_input: { command: "git status --porcelain" },
          }),
          { LEGACY_GUARD_AND_DIFF: "1" }
      )
    : null;

function dirtyCount(): number {
    const run = spawnSync("git", ["status", "--porcelain", "-z", "--no-renames"], { encoding: "utf8" });

    return (run.stdout ?? "").split("\0").filter((line) => line.length > 3).length;
}

out.println(`runs: ${RUNS} (median, 3 warmups discarded)   dirty files here: ${dirtyCount()}`);
out.println(
    `load average: ${loadavg()
        .map((n) => n.toFixed(2))
        .join(", ")}`
);

for (const row of rows) {
    const mark = row.withinBudget ? "ok  " : "OVER";
    out.println(`  ${mark} ${row.stage.padEnd(32)} ${String(row.ms).padStart(7)} ms   budget ${row.budget} ms`);
}

out.println(
    `  ---- reference: the wrapper this replaces, same payload  ${oldClean === null ? "not installed" : `${oldClean.toFixed(1)} ms`}`
);

// ---------------------------------------------------------------------------------------------
// The per-session change-log sink: `recordFileToolChange` (Edit/Write) and `recordBashEdits`
// (Bash), reached from `src/agents/bin/hook-diff-post.ts`. Both no-op without a session id,
// which is a clean "sink off" control for Edit/Write, because nothing else in that path reads
// the session id. For Bash it is NOT clean on its own: `runDiffPost` itself needs a session id
// to build its capture directory, so an absent one skips the whole capture/diff pipeline, not
// only the sink. A second Bash pair below isolates the sink alone by toggling
// `commandEditsFiles` (via the command word) instead, holding the capture/render pipeline
// constant on both sides.
// ---------------------------------------------------------------------------------------------

interface RunSpec {
    entry: string;
    payload: () => Record<string, unknown>;
    env: Record<string, string>;
    beforeEach?: () => void;
}

interface Sample {
    wallMs: number;
    userMs?: number;
    sysMs?: number;
}

const TIME_L = "/usr/bin/time";
// `-l` and the "real user sys" summary line are BSD `time`; GNU time on Linux rejects `-l`.
const canMeasureCpu = process.platform === "darwin" && existsSync(TIME_L);

function runOnce(spec: RunSpec, withCpu: boolean): Sample {
    spec.beforeEach?.();

    const input = SafeJSON.stringify(spec.payload());
    const command = withCpu ? TIME_L : "bun";
    const args = withCpu ? ["-l", "bun", spec.entry] : [spec.entry];
    const started = performance.now();
    const child = spawnSync(command, args, {
        input,
        encoding: "utf8",
        maxBuffer: 64_000_000,
        env: { ...process.env, ...spec.env },
    });
    const wallMs = performance.now() - started;

    if (child.status !== 0) {
        const why = child.error ?? child.signal ?? `exit ${child.status}`;
        throw new Error(`${command} ${args.join(" ")} failed (${why}): ${String(child.stderr).slice(0, 800)}`);
    }

    if (!withCpu) {
        return { wallMs };
    }

    // BSD `time -l` writes one summary line to stderr: "  0.01 real   0.00 user   0.00 sys".
    // Resolution is hundredths of a second, too coarse to separate calls under ~10 ms.
    const match = /([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys/.exec(String(child.stderr));

    return {
        wallMs,
        userMs: match ? Number(match[2]) * 1000 : undefined,
        sysMs: match ? Number(match[3]) * 1000 : undefined,
    };
}

interface Stats {
    min: number;
    median: number;
    max: number;
}

function stats(values: number[]): Stats {
    const sorted = [...values].sort((a, b) => a - b);

    return { min: sorted[0] ?? 0, median: median(sorted), max: sorted[sorted.length - 1] ?? 0 };
}

interface ArmResult {
    wall: Stats;
    userMs: Stats | null;
    sysMs: Stats | null;
}

/** A, B, A, B, ...: both arms warm together, and the first 3 pairs are discarded warmups. */
function interleave(a: RunSpec, b: RunSpec, runs: number): { a: ArmResult; b: ArmResult } {
    const wallA: number[] = [];
    const wallB: number[] = [];
    const userA: number[] = [];
    const sysA: number[] = [];
    const userB: number[] = [];
    const sysB: number[] = [];

    for (let round = 0; round < runs + 3; round++) {
        const sampleA = runOnce(a, canMeasureCpu);
        const sampleB = runOnce(b, canMeasureCpu);

        if (round < 3) {
            continue;
        }

        wallA.push(sampleA.wallMs);
        wallB.push(sampleB.wallMs);

        if (sampleA.userMs !== undefined && sampleA.sysMs !== undefined) {
            userA.push(sampleA.userMs);
            sysA.push(sampleA.sysMs);
        }

        if (sampleB.userMs !== undefined && sampleB.sysMs !== undefined) {
            userB.push(sampleB.userMs);
            sysB.push(sampleB.sysMs);
        }
    }

    return {
        a: {
            wall: stats(wallA),
            userMs: userA.length > 0 ? stats(userA) : null,
            sysMs: sysA.length > 0 ? stats(sysA) : null,
        },
        b: {
            wall: stats(wallB),
            userMs: userB.length > 0 ? stats(userB) : null,
            sysMs: sysB.length > 0 ? stats(sysB) : null,
        },
    };
}

function freshHome(prefix: string): string {
    const home = mkdtempSync(join(tmpdir(), prefix));

    mkdirSync(join(home, ".genesis-tools", "agents"), { recursive: true });
    // `highlight: "none"` keeps every arm below from paying an unrelated `bat` spawn (measured
    // elsewhere at tens of ms per changed file). Left at the default it would land on BOTH
    // sides of a pair and add noise, not signal, to the sink's own delta.
    writeFileSync(
        join(home, ".genesis-tools", "agents", "hooks.json"),
        SafeJSON.stringify({ diff: { highlight: "none" } })
    );

    return home;
}

function changesPath(home: string, session: string): string {
    return join(home, ".genesis-tools", "agents", session, "changes.jsonl");
}

function agentsSessionDirs(home: string): string[] {
    const dir = join(home, ".genesis-tools", "agents");

    if (!existsSync(dir)) {
        return [];
    }

    return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
}

function report(name: string, arm: ArmResult): RowResult {
    const cpuText =
        arm.userMs && arm.sysMs
            ? `   cpu user ${arm.userMs.median.toFixed(1)} / sys ${arm.sysMs.median.toFixed(1)} ms`
            : "";

    out.println(
        `  ${name.padEnd(58)} min ${arm.wall.min.toFixed(1).padStart(6)}  median ${arm.wall.median
            .toFixed(1)
            .padStart(6)}  max ${arm.wall.max.toFixed(1).padStart(6)} ms${cpuText}`
    );

    return {
        stage: name,
        ms: Number(arm.wall.median.toFixed(1)),
        min: Number(arm.wall.min.toFixed(1)),
        max: Number(arm.wall.max.toFixed(1)),
        budget: Number.POSITIVE_INFINITY,
        withinBudget: true,
        ...(arm.userMs && arm.sysMs
            ? { userMs: Number(arm.userMs.median.toFixed(1)), sysMs: Number(arm.sysMs.median.toFixed(1)) }
            : {}),
    };
}

out.println("");
out.println(`change-log sink cost (interleaved A/B, ${RUNS} pairs, 3 warmup pairs discarded):`);

// --- Edit/Write: recordFileToolChange, gated ONLY by the session id. A clean A/B pair. ---

const editHomeOff = freshHome("hook-bench-edit-off-");
const editHomeOn = freshHome("hook-bench-edit-on-");
const editFile = join(mkdtempSync(join(tmpdir(), "hook-bench-edit-file-")), "f.txt");

writeFileSync(editFile, "line one\nline two (changed)\n");

function editPayload(sessionId: string | undefined): Record<string, unknown> {
    return {
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        cwd,
        tool_use_id: "bench-edit-call",
        ...(sessionId ? { session_id: sessionId } : {}),
        tool_input: { file_path: editFile, old_string: "line two", new_string: "line two (changed)" },
        tool_response: { originalFile: "line one\nline two\n" },
    };
}

const editOff: RunSpec = {
    entry: "src/agents/bin/hook-diff-post.ts",
    payload: () => editPayload(undefined),
    env: { GENESIS_TOOLS_HOME: editHomeOff },
};
const editOn: RunSpec = {
    entry: "src/agents/bin/hook-diff-post.ts",
    payload: () => editPayload("bench-edit-sink"),
    env: { GENESIS_TOOLS_HOME: editHomeOn },
};

const editResult = interleave(editOff, editOn, RUNS);

rows.push(report("post phase, Edit, sink off", editResult.a));
rows.push(report("post phase, Edit, sink on", editResult.b));
out.println(`    delta (sink on - off): ${(editResult.b.wall.median - editResult.a.wall.median).toFixed(1)} ms`);

// --- Bash pair A: the literal "session id absent" recipe. Confounded for Bash (see header). ---

const bashHomeOff = freshHome("hook-bench-bash-off-");
const bashHomeOn = freshHome("hook-bench-bash-on-");
const bashDirOff = mkdtempSync(join(tmpdir(), "hook-bench-bash-scratch-off-"));
const bashDirOn = mkdtempSync(join(tmpdir(), "hook-bench-bash-scratch-on-"));
const bashFileOff = join(bashDirOff, "f.txt");
const bashFileOn = join(bashDirOn, "f.txt");

writeFileSync(bashFileOff, "before-0\n");
writeFileSync(bashFileOn, "before-0\n");

const sedCommand = (file: string) => `sed -i '' 's|before|after|' ${file}`;
const catCommand = (file: string) => `cat ${file}`;

function bashPrePayload(dir: string, command: string, sessionId: string | undefined): Record<string, unknown> {
    return {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        cwd: dir,
        tool_use_id: "bench-bash-call",
        ...(sessionId ? { session_id: sessionId } : {}),
        tool_input: { command },
    };
}

function bashPostPayload(dir: string, command: string, sessionId: string | undefined): Record<string, unknown> {
    return {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        cwd: dir,
        tool_use_id: "bench-bash-call",
        ...(sessionId ? { session_id: sessionId } : {}),
        tool_input: { command },
        tool_response: { stdout: "" },
    };
}

function runPre(env: Record<string, string>, payload: Record<string, unknown>): void {
    const child = spawnSync("bun", ["src/agents/bin/hook-pre.ts"], {
        input: SafeJSON.stringify(payload),
        encoding: "utf8",
        maxBuffer: 64_000_000,
        env: { ...process.env, ...env },
    });

    if (child.status !== 0) {
        throw new Error(`hook-pre.ts setup failed: ${String(child.stderr).slice(0, 800)}`);
    }
}

/**
 * One Bash arm: a scratch file the PRE phase captures, mutated fresh before every timed POST
 * call so the file always reads as changed. `commandOf` picks whether the command word makes
 * `commandEditsFiles` true (`sed -i`) or false (`cat`), which is the only thing that decides
 * whether `recordBashEdits` does any work at all.
 */
function bashArm(
    dir: string,
    file: string,
    commandOf: (file: string) => string,
    sessionId: string | undefined,
    home: string
): RunSpec {
    let counter = 0;

    return {
        entry: "src/agents/bin/hook-diff-post.ts",
        payload: () => bashPostPayload(dir, commandOf(file), sessionId),
        env: { GENESIS_TOOLS_HOME: home },
        beforeEach: () => {
            counter += 1;
            runPre({ GENESIS_TOOLS_HOME: home }, bashPrePayload(dir, commandOf(file), sessionId));
            writeFileSync(file, `before-${counter}\n`);
        },
    };
}

const bashOff = bashArm(bashDirOff, bashFileOff, sedCommand, undefined, bashHomeOff);
const bashOn = bashArm(bashDirOn, bashFileOn, sedCommand, "bench-bash-sink", bashHomeOn);

const bashPipelineResult = interleave(bashOff, bashOn, RUNS);

rows.push(report("post phase, Bash sed, session absent (pipeline+sink off)", bashPipelineResult.a));
rows.push(report("post phase, Bash sed, session present (pipeline+sink on)", bashPipelineResult.b));
out.println(
    `    delta (session present - absent): ${(bashPipelineResult.b.wall.median - bashPipelineResult.a.wall.median).toFixed(1)} ms` +
        "  -- CONFOUNDED: session id also gates the whole capture/diff pipeline for Bash, not only the sink"
);

// --- Bash pair B: the isolated sink cost. Session id is present on BOTH sides, so the ---
// --- capture/render pipeline runs identically; only `commandEditsFiles` differs.       ---

const SESSION_ISOL = "bench-bash-isolated";
const isolHomeRenderOnly = freshHome("hook-bench-bash-render-");
const isolHomeRenderSink = freshHome("hook-bench-bash-rendersink-");
const isolDirRenderOnly = mkdtempSync(join(tmpdir(), "hook-bench-bash-scratch-render-"));
const isolDirRenderSink = mkdtempSync(join(tmpdir(), "hook-bench-bash-scratch-rendersink-"));
const isolFileRenderOnly = join(isolDirRenderOnly, "f.txt");
const isolFileRenderSink = join(isolDirRenderSink, "f.txt");

writeFileSync(isolFileRenderOnly, "before-0\n");
writeFileSync(isolFileRenderSink, "before-0\n");

const renderOnly = bashArm(isolDirRenderOnly, isolFileRenderOnly, catCommand, SESSION_ISOL, isolHomeRenderOnly);
const renderPlusSink = bashArm(isolDirRenderSink, isolFileRenderSink, sedCommand, SESSION_ISOL, isolHomeRenderSink);

const isolatedResult = interleave(renderOnly, renderPlusSink, RUNS);

rows.push(report("post phase, Bash, render only (commandEditsFiles=false, sink skipped)", isolatedResult.a));
rows.push(report("post phase, Bash, render+sink (commandEditsFiles=true, sink on)", isolatedResult.b));
out.println(
    `    delta (isolated sink cost): ${(isolatedResult.b.wall.median - isolatedResult.a.wall.median).toFixed(1)} ms`
);

// --- Cold: one fresh home, first-ever call, so `ensureRepo` pays `git init --bare`. ---
// --- Single sample by construction: reported as an observation, not a confidence claim. ---

const coldEditHome = freshHome("hook-bench-edit-cold-");
const coldEditSample = runOnce(
    {
        entry: "src/agents/bin/hook-diff-post.ts",
        payload: () => editPayload("bench-cold"),
        env: { GENESIS_TOOLS_HOME: coldEditHome },
    },
    canMeasureCpu
);

const coldBashHome = freshHome("hook-bench-bash-cold-");
const coldBashDir = mkdtempSync(join(tmpdir(), "hook-bench-bash-cold-scratch-"));
const coldBashFile = join(coldBashDir, "f.txt");

writeFileSync(coldBashFile, "before-0\n");
runPre({ GENESIS_TOOLS_HOME: coldBashHome }, bashPrePayload(coldBashDir, sedCommand(coldBashFile), "bench-cold"));
writeFileSync(coldBashFile, "before-1\n");

const coldBashSample = runOnce(
    {
        entry: "src/agents/bin/hook-diff-post.ts",
        payload: () => bashPostPayload(coldBashDir, sedCommand(coldBashFile), "bench-cold"),
        env: { GENESIS_TOOLS_HOME: coldBashHome },
    },
    canMeasureCpu
);

out.println("");
out.println("cold (fresh home, first-ever call, single sample -- pays git init --bare once):");
out.println(`  Edit sink on:        ${coldEditSample.wallMs.toFixed(1)} ms`);
out.println(`  Bash render+sink on: ${coldBashSample.wallMs.toFixed(1)} ms`);

rows.push({
    stage: "cold: Edit sink on, fresh home",
    ms: Number(coldEditSample.wallMs.toFixed(1)),
    budget: Number.POSITIVE_INFINITY,
    withinBudget: true,
    note: "single sample, first-ever call, pays git init --bare",
});
rows.push({
    stage: "cold: Bash render+sink, fresh home",
    ms: Number(coldBashSample.wallMs.toFixed(1)),
    budget: Number.POSITIVE_INFINITY,
    withinBudget: true,
    note: "single sample, first-ever call, pays git init --bare",
});

// --- Controls: the sink must leave a row exactly where the session id says it should. ---

const controls: string[] = [];

function expectRows(path: string, label: string): void {
    if (!existsSync(path)) {
        controls.push(`FAIL  ${label}: expected a row at ${path}, found nothing`);
        return;
    }

    const count = readFileSync(path, "utf8").split("\n").filter(Boolean).length;

    controls.push(count > 0 ? `ok    ${label}: ${count} row(s) at ${path}` : `FAIL  ${label}: ${path} is empty`);
}

function expectNoSessionDir(home: string, label: string): void {
    const dirs = agentsSessionDirs(home);

    controls.push(
        dirs.length === 0
            ? `ok    ${label}: no session directory under ${home}`
            : `FAIL  ${label}: expected no session directory under ${home}, found ${dirs.join(", ")}`
    );
}

expectNoSessionDir(editHomeOff, "Edit sink off (negative control)");
expectRows(changesPath(editHomeOn, "bench-edit-sink"), "Edit sink on (positive control)");
expectNoSessionDir(bashHomeOff, "Bash session-absent (negative control)");
expectRows(changesPath(bashHomeOn, "bench-bash-sink"), "Bash session-present (positive control)");
expectNoSessionDir(isolHomeRenderOnly, "Bash render-only, commandEditsFiles=false (negative control)");
expectRows(
    changesPath(isolHomeRenderSink, SESSION_ISOL),
    "Bash render+sink, commandEditsFiles=true (positive control)"
);

out.println("");
out.println("controls:");
for (const line of controls) {
    out.println(`  ${line}`);
}

if (!canMeasureCpu) {
    out.println("");
    out.println(`BSD ${TIME_L} -l is not available: cpu user/sys figures are left out, wall-clock only.`);
}

if (jsonIndex >= 0) {
    const path = process.argv[jsonIndex + 1] ?? join(tmpdir(), "hook-latency.json");

    writeFileSync(path, `${SafeJSON.stringify({ runs: RUNS, rows, oldWrapperMs: oldClean, controls }, null, 2)}\n`);
    out.println(`wrote ${path}`);
}

const controlsOk = controls.every((line) => !line.startsWith("FAIL"));

process.exit(rows.every((row) => row.withinBudget) && controlsOk ? 0 : 1);
