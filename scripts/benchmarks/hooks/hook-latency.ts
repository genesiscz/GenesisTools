#!/usr/bin/env bun
/**
 * The hook latency budget, measured. The guard and the pre-phase capture run synchronously
 * on EVERY Bash call, so an unmeasured port is how a 60 ms tax becomes a 300 ms one.
 *
 * Read-only: it pipes fixed payloads into the entrypoints and into the guard this port
 * replaces. It writes only under /tmp.
 *
 * Usage: bun scripts/benchmarks/hooks/hook-latency.ts [--runs 20] [--json <path>]
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";

const OLD_WRAPPER = join(homedir(), ".claude", "hooks", "announce-hook-bg.sh");
const runsIndex = process.argv.indexOf("--runs");
const RUNS = runsIndex >= 0 ? Number(process.argv[runsIndex + 1]) : 20;
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

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
}

function timeIt(command: string, args: string[], input: string, env: Record<string, string> = {}): number {
    const values: number[] = [];

    for (let run = 0; run < RUNS + 3; run++) {
        const started = performance.now();

        spawnSync(command, args, {
            input,
            encoding: "utf8",
            maxBuffer: 64_000_000,
            env: { ...process.env, ...env },
        });

        const elapsed = performance.now() - started;

        // Three warmups, discarded: the first runs pay the filesystem cache.
        if (run >= 3) {
            values.push(elapsed);
        }
    }

    return median(values);
}

const rows: { stage: string; ms: number; budget: number; withinBudget: boolean }[] = [];

for (const stage of STAGES) {
    const ms = timeIt("bun", [stage.entry], SafeJSON.stringify(stage.payload));
    const budget = BUDGET_MS[stage.name] ?? Number.POSITIVE_INFINITY;

    rows.push({ stage: stage.name, ms: Number(ms.toFixed(1)), budget, withinBudget: ms <= budget });
}

// `LEGACY_GUARD_AND_DIFF=1` turns the legacy guard and capture back on FOR THIS CALL. After
// the cutover the wrapper is neutered, and without this the reference line timed an empty
// script and still printed a figure that looked fine: 48 ms became 5.9 ms with no warning.
const oldClean = timeIt(
    "sh",
    [OLD_WRAPPER],
    SafeJSON.stringify({ ...base, hook_event_name: "PreToolUse", tool_input: { command: "git status --porcelain" } }),
    { LEGACY_GUARD_AND_DIFF: "1" }
);

out.println(`runs: ${RUNS} (median, 3 warmups discarded)   dirty files here: ${dirtyCount()}`);

for (const row of rows) {
    const mark = row.withinBudget ? "ok  " : "OVER";
    out.println(`  ${mark} ${row.stage.padEnd(32)} ${String(row.ms).padStart(7)} ms   budget ${row.budget} ms`);
}

out.println(`  ---- reference: the wrapper this replaces, same payload  ${oldClean.toFixed(1)} ms`);

function dirtyCount(): number {
    const run = spawnSync("git", ["status", "--porcelain", "-z", "--no-renames"], { encoding: "utf8" });

    return (run.stdout ?? "").split("\0").filter((line) => line.length > 3).length;
}

if (jsonIndex >= 0) {
    const path = process.argv[jsonIndex + 1] ?? join(tmpdir(), "hook-latency.json");

    writeFileSync(path, `${SafeJSON.stringify({ runs: RUNS, rows, oldWrapperMs: oldClean }, null, 2)}\n`);
    out.println(`wrote ${path}`);
}

process.exit(rows.every((row) => row.withinBudget) ? 0 : 1);
