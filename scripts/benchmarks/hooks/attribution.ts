#!/usr/bin/env bun
/**
 * The cost of attributing a changed file to the session that caused it, measured on the hot path.
 *
 * The Bash diff hook runs a pre and a post phase around EVERY Bash call of every agent session on
 * the machine. Attribution adds a per-session mention index (read, extend, append), a transcript
 * tail, and in the post phase a lazy read of the touches ledger and the in-flight captures. This
 * script prices one pre+post pair before and after, on two roots:
 *
 *   repo   a shared clone of this checkout with 5 dirty files
 *   vault  a synthetic notes repository with 800 dirty files (400 edited, 400 untracked), the
 *          shape that overflowed the 400-file capture cap on 2026-09-30
 *
 * Each pair is measured twice: IN-PROCESS (`capturePre` + `runDiffPost` imported from `--impl`,
 * wall, CPU and spawns through `withSpawnCounter`) and END TO END (the two entrypoints spawned
 * with a payload, wall and CPU from the child's rusage, which includes its git children).
 *
 * Isolation: TMPDIR and GENESIS_TOOLS_HOME point at a scratch directory for this process and its
 * children, so no real capture, ledger, index, journal or decision log is read or written.
 *
 * ```
 * bun scripts/benchmarks/hooks/attribution.ts --impl <checkout-before> --baseline
 * bun scripts/benchmarks/hooks/attribution.ts --compare
 * bun scripts/benchmarks/hooks/attribution.ts --transcript <claude-transcript.jsonl>   # real inputs for the index
 * ```
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    type BaselineMetrics,
    compareToBaseline,
    formatComparison,
    recordBaseline,
    withSpawnCounter,
} from "@app/benchmark/lib";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { formatTable } from "@genesiscz/utils/table";
import { Command } from "commander";

interface Flags {
    impl?: string;
    runs: string;
    baseline?: boolean;
    compare?: boolean;
    json?: boolean;
    transcript?: string;
}

const program = new Command()
    .name("hooks-attribution")
    .description("Price one pre+post pair of the Bash diff hook, and the session mention index")
    .option("--impl <checkout>", "Checkout whose hook code is measured (default: this one)")
    .option("--runs <n>", "Pairs measured per root; the median is reported", "15")
    .option("--baseline", "Record the medians as the baseline")
    .option("--compare", "Measure again and diff against the recorded baseline")
    .option("--json", "Emit the machine-readable result on stdout")
    .option("--transcript <path>", "Draw the 5000 index inputs from a real Claude transcript");

program.parse(process.argv);

const flags = program.opts<Flags>();
const RUNS = Math.max(3, Number.parseInt(flags.runs, 10) || 15);
const HERE = resolve(import.meta.dir, "..", "..", "..");
const IMPL = resolve(flags.impl ?? HERE);
// Canonical, as `git rev-parse --show-toplevel` reports it; `/var` is a symlink on macOS.
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), "gt-bench-attribution-")));

// Before any hook module is imported: every path they build reads these at call time.
process.env.TMPDIR = join(SCRATCH, "tmp");
process.env.GENESIS_TOOLS_HOME = join(SCRATCH, "home");
mkdirSync(process.env.TMPDIR, { recursive: true });
mkdirSync(join(process.env.GENESIS_TOOLS_HOME, ".genesis-tools", "agents"), { recursive: true });
writeFileSync(
    join(process.env.GENESIS_TOOLS_HOME, ".genesis-tools", "agents", "hooks.json"),
    SafeJSON.stringify({ shadow: false, diff: { highlight: "none" } })
);

interface HookModules {
    capturePre: (payload: unknown, diff: unknown) => unknown;
    runDiffPost: (payload: unknown, config: unknown) => { decision: string; files: string[] };
    config: { diff: Record<string, unknown> } & Record<string, unknown>;
}

async function loadImpl(): Promise<HookModules> {
    const capture = await import(join(IMPL, "src/agents/lib/hooks/diff/capture.ts"));
    const run = await import(join(IMPL, "src/agents/lib/hooks/diff/run.ts"));
    const config = await import(join(IMPL, "src/agents/lib/hooks/config.ts"));
    const base = config.DEFAULT_HOOKS_CONFIG as HookModules["config"];

    return {
        capturePre: capture.capturePre,
        runDiffPost: run.runDiffPost,
        config: { ...base, diff: { ...base.diff, highlight: "none" } },
    };
}

function git(root: string, args: string[]): string {
    const run = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });

    if (run.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed in ${root}: ${run.stderr}`);
    }

    return run.stdout;
}

function repoRoot(): { root: string; target: string } {
    const root = join(SCRATCH, "repo");

    spawnSync("git", ["clone", "-q", "--shared", HERE, root], { encoding: "utf8" });

    const files = git(root, ["ls-files", "src/agents/lib/hooks"]).split("\n").filter(Boolean).slice(0, 5);

    for (const file of files) {
        writeFileSync(join(root, file), `${readFileSync(join(root, file), "utf8")}\n// bench dirty\n`);
    }

    return { root, target: files[0] ?? "README.md" };
}

function vaultRoot(): { root: string; target: string } {
    const root = join(SCRATCH, "vault");

    mkdirSync(root, { recursive: true });
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "bench@example.com"]);
    git(root, ["config", "user.name", "bench"]);

    for (let i = 0; i < 600; i += 1) {
        mkdirSync(join(root, `area-${i % 12}`), { recursive: true });
        writeFileSync(join(root, `area-${i % 12}`, `note-${i}.md`), `# Note ${i}\n\n${"line of text\n".repeat(40)}`);
    }

    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "seed"]);

    for (let i = 0; i < 400; i += 1) {
        writeFileSync(join(root, `area-${i % 12}`, `note-${i}.md`), `# Note ${i} edited\n\n${"line\n".repeat(60)}`);
    }

    for (let i = 0; i < 400; i += 1) {
        mkdirSync(join(root, `inbox-${i % 4}`), { recursive: true });
        writeFileSync(join(root, `inbox-${i % 4}`, `draft-${i}.md`), `draft ${i}\n${"text\n".repeat(30)}`);
    }

    return { root, target: "area-3/note-3.md" };
}

/** Other sessions on the machine: 20 idle ones with state, and 5 with a capture in another root. */
function populateOtherSessions(): void {
    const mentions = join(process.env.TMPDIR ?? "", "GenesisTools", "ai", "hooks", "mentions");
    const data = join(process.env.TMPDIR ?? "", "GenesisTools", "ai", "hooks", "data", "claude");

    mkdirSync(mentions, { recursive: true });

    for (let i = 0; i < 20; i += 1) {
        writeFileSync(join(mentions, `bench-other-${i}.json`), SafeJSON.stringify({ lastPre: Date.now() - 60_000 }));
    }

    for (let i = 0; i < 5; i += 1) {
        const call = join(data, `bench-busy-${i}`, "diff", "call-1");

        mkdirSync(call, { recursive: true });
        writeFileSync(join(call, "stamp"), String(Math.floor(Date.now() / 1000)));
        writeFileSync(join(call, "roots.txt"), `${join(SCRATCH, `elsewhere-${i}`)}\n`);
    }
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

function round(value: number): number {
    return Number(value.toFixed(2));
}

/**
 * What the measured "command" does: it edits the file it names, and a second file it does not
 * name, the way a codemod would. The unnamed one is what makes the post phase read the touches
 * ledger and the in-flight captures, so the pair prices the slow path of attribution too.
 */
const UNNAMED = "bench-unnamed.md";

function edit(root: string, target: string, label: string): void {
    writeFileSync(join(root, target), `${readFileSync(join(root, target), "utf8")}${label}\n`);
    writeFileSync(join(root, UNNAMED), `${label}\n`);
}

let callCounter = 0;

function payloadFor(root: string, target: string, session: string) {
    callCounter += 1;

    return {
        event: "PreToolUse",
        tool: "Bash",
        cwd: root,
        sessionId: session,
        toolUseId: `bench-${callCounter}`,
        command: `bun scripts/fmt.ts ${target}`,
        model: "",
        harness: "claude" as const,
        nativeDiffFiles: [],
        raw: {},
    };
}

async function inProcessPair(hooks: HookModules, root: string, target: string) {
    const walls: number[] = [];
    const cpus: number[] = [];
    const spawns: number[] = [];

    for (let run = 0; run < RUNS + 2; run += 1) {
        const payload = payloadFor(root, target, "bench-self");
        const cpu = process.cpuUsage();
        const started = performance.now();
        const counted = await withSpawnCounter(async () => {
            hooks.capturePre(payload, hooks.config.diff);
            edit(root, target, `edit ${run}`);
            return hooks.runDiffPost(payload, hooks.config);
        });
        const wall = performance.now() - started;
        const used = process.cpuUsage(cpu);

        if (counted.result.files.length < 2) {
            throw new Error(`the pair rendered nothing for ${target}: ${SafeJSON.stringify(counted.result)}`);
        }

        // The first two runs warm the module graph and the git index; they are not reported.
        if (run >= 2) {
            walls.push(wall);
            cpus.push((used.user + used.system) / 1000);
            spawns.push(counted.count);
        }
    }

    return { wall: median(walls), cpu: median(cpus), spawns: median(spawns) };
}

function spawnHook(entry: string, payload: Record<string, unknown>): { wallMs: number; cpuMs: number } {
    const started = performance.now();
    const run = Bun.spawnSync(["bun", join(IMPL, "src/agents/bin", entry)], {
        stdin: Buffer.from(SafeJSON.stringify(payload)),
        env: process.env,
    });

    if (run.exitCode !== 0) {
        throw new Error(`${entry} exited ${run.exitCode}: ${run.stderr.toString()}`);
    }

    return { wallMs: performance.now() - started, cpuMs: Number(run.resourceUsage.cpuTime.total) / 1000 };
}

function endToEndPair(root: string, target: string) {
    const walls: number[] = [];
    const cpus: number[] = [];

    for (let run = 0; run < RUNS + 1; run += 1) {
        callCounter += 1;

        const base = {
            tool_name: "Bash",
            cwd: root,
            session_id: "bench-e2e",
            tool_use_id: `bench-e2e-${callCounter}`,
            tool_input: { command: `bun scripts/fmt.ts ${target}` },
        };
        const pre = spawnHook("hook-pre.ts", { ...base, hook_event_name: "PreToolUse" });

        edit(root, target, `e2e ${run}`);

        const post = spawnHook("hook-diff-post.ts", {
            ...base,
            hook_event_name: "PostToolUse",
            tool_response: { stdout: "" },
        });

        if (run >= 1) {
            walls.push(pre.wallMs + post.wallMs);
            cpus.push(pre.cpuMs + post.cpuMs);
        }
    }

    return { wall: median(walls), cpu: median(cpus) };
}

/**
 * The Stop phase: the unpushed reminder's git processes on a branch with 4 unpushed commits,
 * cold (a new HEAD) and cached, measured in-process. Only the after-state has this module.
 */
async function stopSpawns(root: string): Promise<BaselineMetrics> {
    const unpushed = await import(join(IMPL, "src/agents/lib/hooks/unpushed.ts"));

    // A new HEAD, so the first look misses the cache the end-to-end runs filled.
    git(root, ["commit", "-q", "--allow-empty", "-m", "bench unpushed, new head"]);

    const cold = await withSpawnCounter(async () => unpushed.unpushedState(root));
    const cached = await withSpawnCounter(async () => unpushed.unpushedState(root));

    return {
        "stop.unpushedCommits": cold.result?.count ?? -1,
        "stop.coldSpawns": cold.count,
        "stop.cachedSpawns": cached.count,
    };
}

/** The Stop entrypoint end to end, for a session whose state names `root`. */
function stopEndToEnd(root: string) {
    git(root, ["config", "user.email", "bench@example.com"]);
    git(root, ["config", "user.name", "bench"]);

    for (let index = 0; index < 4; index += 1) {
        git(root, ["commit", "-q", "--allow-empty", "-m", `bench unpushed ${index}`]);
    }

    const mentions = join(process.env.TMPDIR ?? "", "GenesisTools", "ai", "hooks", "mentions");

    mkdirSync(mentions, { recursive: true });
    writeFileSync(join(mentions, "bench-stop.json"), SafeJSON.stringify({ lastPre: Date.now(), roots: [root] }));

    const walls: number[] = [];
    const cpus: number[] = [];

    for (let run = 0; run < RUNS + 1; run += 1) {
        const stop = spawnHook("hook-stop.ts", { hook_event_name: "Stop", session_id: "bench-stop", cwd: root });

        if (run >= 1) {
            walls.push(stop.wallMs);
            cpus.push(stop.cpuMs);
        }
    }

    return { wall: median(walls), cpu: median(cpus) };
}

/** 5000 tool inputs: drawn from a real transcript when given, else a deterministic synthetic mix. */
function toolInputs(cwd: string): Array<{ tool: string; input: unknown; cwd: string }> {
    const inputs: Array<{ tool: string; input: unknown; cwd: string }> = [];

    if (flags.transcript) {
        for (const line of readFileSync(flags.transcript, "utf8").split("\n")) {
            if (inputs.length >= 5000) {
                break;
            }

            if (!line.includes('"type":"tool_use"')) {
                continue;
            }

            const parsed = SafeJSON.parse(line, { strict: true }) as {
                cwd?: string;
                message?: { content?: Array<{ type?: string; name?: string; input?: unknown }> };
            };

            for (const block of parsed.message?.content ?? []) {
                if (block.type === "tool_use" && block.name && parsed.cwd) {
                    inputs.push({ tool: block.name, input: block.input, cwd: parsed.cwd });
                }
            }
        }

        return inputs.slice(0, 5000);
    }

    for (let i = 0; i < 5000; i += 1) {
        const file = `src/area-${i % 40}/module-${i % 800}.ts`;

        switch (i % 5) {
            case 0:
                inputs.push({ tool: "Read", input: { file_path: join(cwd, file) }, cwd });
                break;
            case 1:
                inputs.push({ tool: "Edit", input: { file_path: join(cwd, file) }, cwd });
                break;
            case 2:
                inputs.push({ tool: "Grep", input: { pattern: "x", path: join(cwd, `src/area-${i % 40}`) }, cwd });
                break;
            default:
                inputs.push({
                    tool: "Bash",
                    input: { command: `cd ${cwd} && rg -n foo ${file} src/area-${(i + 1) % 40}/ | head -5` },
                    cwd,
                });
        }
    }

    return inputs;
}

async function indexMetrics(): Promise<BaselineMetrics> {
    const mentions = await import(join(IMPL, "src/agents/lib/hooks/diff/mentions.ts"));
    const cwd = join(SCRATCH, "index-cwd");
    const inputs = toolInputs(cwd);
    const session = "bench-index";
    const known = mentions.loadMentions(session);
    let appendMs = 0;

    for (const input of inputs) {
        const started = performance.now();

        mentions.appendMentions(session, known, mentions.mentionsOf(input));
        appendMs += performance.now() - started;
    }

    const file = join(process.env.TMPDIR ?? "", "GenesisTools", "ai", "hooks", "mentions", `${session}.txt`);
    const loads: number[] = [];

    for (let i = 0; i < 20; i += 1) {
        const started = performance.now();

        mentions.loadMentions(session);
        loads.push(performance.now() - started);
    }

    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).length;

    return {
        indexInputs: inputs.length,
        indexBytes: statSync(file).size,
        indexEntries: lines,
        indexLoadMs: round(median(loads)),
        indexAppendMsPerInput: round(appendMs / inputs.length),
    };
}

async function measure(): Promise<{ pair: BaselineMetrics; index: BaselineMetrics | null }> {
    const hooks = await loadImpl();
    const pair: BaselineMetrics = {};

    populateOtherSessions();

    for (const [name, fixture] of [
        ["repo", repoRoot()],
        ["vault", vaultRoot()],
    ] as const) {
        out.log.info(`measuring ${name} (${RUNS} pairs in-process, ${RUNS} end to end)`);

        const inProcess = await inProcessPair(hooks, fixture.root, fixture.target);
        const e2e = endToEndPair(fixture.root, fixture.target);

        pair[`${name}.pairWallMs`] = round(inProcess.wall);
        pair[`${name}.pairCpuMs`] = round(inProcess.cpu);
        pair[`${name}.pairSpawns`] = inProcess.spawns;
        pair[`${name}.e2eWallMs`] = round(e2e.wall);
        pair[`${name}.e2eCpuMs`] = round(e2e.cpu);
    }

    const repo = join(SCRATCH, "repo");
    const stop = stopEndToEnd(repo);

    pair["stop.e2eWallMs"] = round(stop.wall);
    pair["stop.e2eCpuMs"] = round(stop.cpu);

    let index: BaselineMetrics | null = null;

    try {
        index = { ...(await stopSpawns(repo)), ...(await indexMetrics()) };
    } catch (err) {
        // The before-state has no mention index; that is the expected answer there.
        out.log.warn(`no mention index in ${IMPL}: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { pair, index };
}

const uptime = spawnSync("uptime", { encoding: "utf8" }).stdout.trim();
const { pair, index } = await measure();

out.println(`\nBash diff hook, one pre+post pair — impl ${IMPL}`);
out.println(uptime);
out.println(
    formatTable(
        Object.entries({ ...pair, ...(index ?? {}) }).map(([metric, value]) => [metric, String(value)]),
        ["METRIC", "MEDIAN"],
        { alignRight: [1] }
    )
);

const NAME = "hooks-attribution-pair";
/**
 * The budget this change is held to: at most 2 ms more wall or CPU per in-process pair and 5 ms
 * per end-to-end pair (a bun start alone varies by more), and not one extra process.
 */
const FLOOR: Record<string, number> = {
    "repo.pairWallMs": 2,
    "repo.pairCpuMs": 2,
    "vault.pairWallMs": 2,
    "vault.pairCpuMs": 2,
    "repo.e2eWallMs": 5,
    "repo.e2eCpuMs": 5,
    "vault.e2eWallMs": 5,
    "vault.e2eCpuMs": 5,
    "stop.e2eWallMs": 5,
    "stop.e2eCpuMs": 5,
    "repo.pairSpawns": 0,
    "vault.pairSpawns": 0,
};

if (flags.baseline) {
    const recorded = await recordBaseline({
        name: NAME,
        metrics: pair,
        notes: `impl ${IMPL} | ${RUNS} pairs | ${uptime}`,
    });

    out.println(`\nRecorded baseline ${NAME} at commit ${recorded.commit}.`);
}

if (flags.compare) {
    const cmp = await compareToBaseline({ name: NAME, metrics: pair, tolerancePct: 15, floor: FLOOR });

    out.println(`\n${formatComparison(cmp)}`);

    if (!cmp.ok) {
        process.exitCode = 1;
    }
}

if (flags.json) {
    out.result({ impl: IMPL, runs: RUNS, pair, index });
}

// A shared clone of this checkout plus the vault fixture is about 90 MB per run. Twelve runs left
// 1.1 GB in the temp folder before this line existed.
rmSync(SCRATCH, { recursive: true, force: true });
