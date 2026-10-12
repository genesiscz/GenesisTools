#!/usr/bin/env bun
/**
 * What one Bash tool call costs in the diff hook (pre phase plus post phase), two checkouts A/B in
 * one run. Written for the `git status` change of 2026-10-12: the hooks run one status per root in
 * each phase, and the status was the largest part of the call.
 *
 * One call is `hook-pre.ts`, the command's effect, then `hook-diff-post.ts`, each a fresh bun
 * process fed a payload, as the harness runs them. CPU is the two processes' rusage, which includes
 * the git and tar processes they waited for. Two command shapes per arm:
 *
 *   edit  a runner command that edits the file it names and a file it does not name
 *   read  a read-only command (`rg`) that changes nothing
 *
 * The git spawns per call are counted in-process (`withSpawnCounter`), once per arm and shape:
 * counts are deterministic.
 *
 * The target repository is a shared clone of this checkout (every tracked file) with 5 edited files
 * and one untracked directory, the shape of a working session. The arms alternate per run (AB, BA).
 *
 * Isolation: TMPDIR and GENESIS_TOOLS_HOME point at a scratch directory for this process and its
 * children, so no real capture, ledger, change log or decision log is read or written.
 *
 * ```
 * bun scripts/benchmarks/hooks/status-ab.ts --before <checkout of the old code> [--runs 9] [--baseline | --compare] [--json]
 * ```
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type BaselineMetrics, withSpawnCounter } from "@app/benchmark/lib";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { finishBench, parseBenchArgs } from "../fs/shared";

const args = parseBenchArgs(process.argv);
const beforeIndex = process.argv.indexOf("--before");

if (beforeIndex < 0 || !process.argv[beforeIndex + 1]) {
    out.println("--before <checkout> is required: a checkout of the code to compare against, with node_modules");
    process.exit(1);
}

const HERE = resolve(import.meta.dir, "..", "..", "..");
const ARMS = { before: resolve(process.argv[beforeIndex + 1] ?? ""), after: HERE } as const;
type Arm = keyof typeof ARMS;
const SHAPES = ["edit", "read"] as const;
type Shape = (typeof SHAPES)[number];

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), "gt-bench-status-")));

// Before any hook module is imported: every path they build reads these at call time.
process.env.TMPDIR = join(SCRATCH, "tmp");
process.env.GENESIS_TOOLS_HOME = join(SCRATCH, "home");
mkdirSync(process.env.TMPDIR, { recursive: true });
mkdirSync(join(process.env.GENESIS_TOOLS_HOME, ".genesis-tools", "agents"), { recursive: true });
writeFileSync(
    join(process.env.GENESIS_TOOLS_HOME, ".genesis-tools", "agents", "hooks.json"),
    SafeJSON.stringify({ shadow: false, diff: { highlight: "none" } })
);

function git(root: string, gitArgs: string[]): string {
    const run = spawnSync("git", ["-C", root, ...gitArgs], { encoding: "utf8" });

    if (run.status !== 0) {
        throw new Error(`git ${gitArgs.join(" ")} failed in ${root}: ${run.stderr}`);
    }

    return run.stdout;
}

const ROOT = join(SCRATCH, "repo");
spawnSync("git", ["clone", "-q", "--shared", HERE, ROOT], { encoding: "utf8" });

const tracked = git(ROOT, ["ls-files"]).split("\n").filter(Boolean);
const dirty = tracked.filter((file) => file.startsWith("src/agents/lib/hooks/") && file.endsWith(".ts")).slice(0, 5);
const TARGET = dirty[0] ?? "README.md";

/**
 * Moves a file's mtime an hour back. The post phase admits a file changed since the command's start
 * in WHOLE seconds, so a file written by the previous call in the same second would count as this
 * call's change and make the arms do different work depending on the clock.
 */
function age(name: string): void {
    const past = Date.now() / 1000 - 3600;

    utimesSync(join(ROOT, name), past, past);
}

for (const file of dirty) {
    appendFileSync(join(ROOT, file), "\n// bench: dirty before the session's command\n");
    age(file);
}

mkdirSync(join(ROOT, "notes-scratch"), { recursive: true });

for (let index = 0; index < 3; index += 1) {
    writeFileSync(join(ROOT, "notes-scratch", `note-${index}.md`), `note ${index}\n`);
    age(`notes-scratch/note-${index}.md`);
}

const COMMANDS: Record<Shape, string> = { edit: `bun scripts/fmt.ts ${TARGET}`, read: `rg needle ${TARGET}` };
const UNNAMED = "bench-unnamed.md";
/**
 * ONE session for both arms. With one per arm, a file the other arm's call wrote in the same second
 * reads as another session's change (the touches ledger), is not diffed, and the arms do different
 * work depending on the clock.
 */
const SESSION = "bench";
let callCounter = 0;

function act(shape: Shape, label: string): void {
    if (shape === "read") {
        return;
    }

    appendFileSync(join(ROOT, TARGET), `// ${label}\n`);
    writeFileSync(join(ROOT, UNNAMED), `${label}\n`);
}

/** After the post phase: what this call changed is older than the next call's start, as in real use. */
function settle(shape: Shape): void {
    if (shape === "edit") {
        age(TARGET);
        age(UNNAMED);
    }
}

function spawnHook(arm: Arm, entry: string, payload: Record<string, unknown>) {
    const started = performance.now();
    const run = Bun.spawnSync(["bun", join(ARMS[arm], "src/agents/bin", entry)], {
        stdin: Buffer.from(SafeJSON.stringify(payload)),
        env: process.env,
    });

    if (run.exitCode !== 0) {
        throw new Error(`${arm} ${entry} exited ${run.exitCode}: ${run.stderr.toString()}`);
    }

    return {
        wallMs: performance.now() - started,
        cpuMs: Number(run.resourceUsage.cpuTime.total) / 1000,
        printed: run.stdout.length > 0,
    };
}

/** One tool call end to end: the pre hook, the command's effect, the post hook. */
function endToEnd(arm: Arm, shape: Shape) {
    callCounter += 1;

    const base = {
        tool_name: "Bash",
        cwd: ROOT,
        session_id: SESSION,
        tool_use_id: `bench-${arm}-${callCounter}`,
        tool_input: { command: COMMANDS[shape] },
    };
    const pre = spawnHook(arm, "hook-pre.ts", { ...base, hook_event_name: "PreToolUse" });

    act(shape, `${arm} ${callCounter}`);

    const post = spawnHook(arm, "hook-diff-post.ts", {
        ...base,
        hook_event_name: "PostToolUse",
        tool_response: { stdout: "" },
    });

    settle(shape);

    return { cpuMs: pre.cpuMs + post.cpuMs, wallMs: pre.wallMs + post.wallMs, printed: post.printed };
}

interface HookModules {
    capturePre: (payload: unknown, diff: unknown) => unknown;
    runDiffPost: (payload: unknown, config: unknown) => { files: string[] };
    config: { diff: Record<string, unknown> } & Record<string, unknown>;
}

async function loadArm(arm: Arm): Promise<HookModules> {
    const capture = await import(join(ARMS[arm], "src/agents/lib/hooks/diff/capture.ts"));
    const run = await import(join(ARMS[arm], "src/agents/lib/hooks/diff/run.ts"));
    const config = await import(join(ARMS[arm], "src/agents/lib/hooks/config.ts"));
    const base = config.DEFAULT_HOOKS_CONFIG as HookModules["config"];

    return {
        capturePre: capture.capturePre,
        runDiffPost: run.runDiffPost,
        config: { ...base, diff: { ...base.diff, highlight: "none" } },
    };
}

/** git processes one call starts, all of them and the `git status` ones. Deterministic, so N = 1. */
async function countSpawns(
    arm: Arm,
    shape: Shape
): Promise<{ git: number; status: number; files: number; commands: string[] }> {
    const hooks = await loadArm(arm);

    callCounter += 1;

    const payload = {
        event: "PreToolUse",
        tool: "Bash",
        cwd: ROOT,
        sessionId: SESSION,
        toolUseId: `bench-count-${callCounter}`,
        command: COMMANDS[shape],
        model: "",
        harness: "claude" as const,
        nativeDiffFiles: [],
        raw: {},
    };
    const counted = await withSpawnCounter(async () => {
        hooks.capturePre(payload, hooks.config.diff);
        act(shape, `count ${arm} ${callCounter}`);
        return hooks.runDiffPost(payload, hooks.config);
    });

    settle(shape);

    const gitSpawns = counted.spawns.filter((spawn) => spawn.cmd[0] === "git");

    return {
        git: gitSpawns.length,
        status: gitSpawns.filter((spawn) => spawn.cmd.includes("status")).length,
        files: counted.result.files.length,
        // The repository path is the same for both arms; dropping it keeps the list readable.
        commands: gitSpawns.map((spawn) => spawn.cmd.slice(1).join(" ").replaceAll(ROOT, "<repo>")),
    };
}

const counts: BaselineMetrics = {};
const commands: Record<string, string[]> = {};

for (const arm of Object.keys(ARMS) as Arm[]) {
    for (const shape of SHAPES) {
        const counted = await countSpawns(arm, shape);

        counts[`${arm}.${shape}.gitSpawns`] = counted.git;
        counts[`${arm}.${shape}.statusSpawns`] = counted.status;
        counts[`${arm}.${shape}.renderedFiles`] = counted.files;
        commands[`${arm}.${shape}`] = counted.commands;
    }
}

for (let warm = 0; warm < args.warmup; warm += 1) {
    for (const arm of Object.keys(ARMS) as Arm[]) {
        for (const shape of SHAPES) {
            endToEnd(arm, shape);
        }
    }
}

const runs: BaselineMetrics[] = [];
const uptimeBefore = spawnSync("uptime", { encoding: "utf8" }).stdout.trim();

for (let run = 0; run < args.runs; run += 1) {
    const order: Arm[] = run % 2 === 0 ? ["before", "after"] : ["after", "before"];
    const metrics: BaselineMetrics = { ...counts };

    for (const arm of order) {
        for (const shape of SHAPES) {
            const call = endToEnd(arm, shape);

            metrics[`${arm}.${shape}.cpuMs`] = Number(call.cpuMs.toFixed(1));
            metrics[`${arm}.${shape}.wallMs`] = Number(call.wallMs.toFixed(1));
            metrics[`${arm}.${shape}.printed`] = call.printed ? 1 : 0;
        }
    }

    runs.push(metrics);
}

const uptimeAfter = spawnSync("uptime", { encoding: "utf8" }).stdout.trim();

await finishBench({
    name: "hooks-status-ab",
    title: "Bash diff hook, one tool call (pre + post), before vs after",
    args,
    runs,
    // `printed` and `renderedFiles` are check values: a drop means an arm did less work, not better work.
    lowerIsBetter: Object.keys(runs[0] ?? {}).filter(
        (metric) => !metric.endsWith(".printed") && !metric.endsWith(".renderedFiles")
    ),
    floor: Object.fromEntries(
        Object.keys(runs[0] ?? {})
            .filter((metric) => metric.endsWith("Ms"))
            .map((metric) => [metric, 5])
    ),
    notes: `before ${ARMS.before} | ${tracked.length} tracked files, ${dirty.length} dirty, 1 untracked directory | ${uptimeBefore} -> ${uptimeAfter}`,
    context: { scratch: SCRATCH, before: ARMS.before, after: ARMS.after, trackedFiles: tracked.length, commands },
});

out.println(`uptime before: ${uptimeBefore}`);
out.println(`uptime after:  ${uptimeAfter}`);

// A shared clone of this checkout is tens of MB per run.
rmSync(SCRATCH, { recursive: true, force: true });
