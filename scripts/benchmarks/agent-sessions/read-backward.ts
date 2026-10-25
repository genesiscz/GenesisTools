#!/usr/bin/env bun
/**
 * What reading a session from its end costs: `readSessionBackward` on real Claude transcripts, the door the decision
 * Stop hook calls on every turn end while `decisions.chatAnswers` is on.
 *
 * SHAPES (both in each child, see `read-backward-child.ts`):
 *   - `hook`: the hook's read, 8 MB cap, back to the first entry older than a cut (the cut is set an hour ago, so
 *     the busiest transcripts stop early and the quiet ones read to the cap or their start).
 *   - `full`: no entry accepted, 16 MB cap: every entry of the newest 16 MB goes through `until`, the worst case for
 *     the per-entry loop (2026-10-25: `findLastIndex` became a plain loop in 296e7870f2).
 *
 * ARMS, interleaved per run, each a fresh process: `current` is this checkout; `--before <checkout>` adds a second
 * checkout (a worktree at an older commit) whose own code runs. `<arm>.<shape>.entries` and `.found` are the check:
 * both arms must read the same entries.
 *
 * The transcripts are the live ones on this Mac (read-only): the largest few and a medium one, so record the
 * baseline and the comparison close together.
 *
 * Usage:
 *   bun scripts/benchmarks/agent-sessions/read-backward.ts --runs 7
 *   bun scripts/benchmarks/agent-sessions/read-backward.ts --runs 7 --before /tmp/cc/<project>/<session>/worktrees/before
 *   bun scripts/benchmarks/agent-sessions/read-backward.ts --baseline | --compare
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { nativeSessionRoots } from "@genesiscz/utils/providers/session-paths";
import { finishBench, parseBenchArgs } from "../fs/shared";

const BASELINE_NAME = "agent-sessions-read-backward";
const REPO = join(import.meta.dir, "..", "..", "..");
const CHILD = join(import.meta.dir, "read-backward-child.ts");
const args = parseBenchArgs(process.argv.slice(2));
const beforeAt = process.argv.indexOf("--before");
const before = beforeAt > 0 ? process.argv[beforeAt + 1] : undefined;
const arms: Array<{ name: string; checkout: string }> = [
    { name: "current", checkout: REPO },
    ...(before ? [{ name: "before", checkout: before }] : []),
];

/** The four largest Claude transcripts plus one of 2-8 MB (read whole). */
function pickTranscripts(): string[] {
    const files: Array<{ path: string; size: number }> = [];

    for (const root of nativeSessionRoots("claude")) {
        let projects: string[] = [];

        try {
            projects = readdirSync(root);
        } catch {
            continue;
        }

        for (const project of projects) {
            let names: string[] = [];

            try {
                names = readdirSync(join(root, project));
            } catch {
                continue;
            }

            for (const name of names) {
                if (name.endsWith(".jsonl")) {
                    const path = join(root, project, name);
                    files.push({ path, size: statSync(path).size });
                }
            }
        }
    }

    files.sort((a, b) => b.size - a.size);
    const medium = files.find((file) => file.size > 2 * 2 ** 20 && file.size < 8 * 2 ** 20);
    return [...files.slice(0, 4), ...(medium ? [medium] : [])].map((file) => file.path);
}

const transcripts = pickTranscripts();

if (transcripts.length === 0) {
    throw new Error("no Claude transcripts found under the native session roots");
}

const cut = new Date(Date.now() - 60 * 60_000).toISOString();

async function sample(checkout: string): Promise<Record<string, number>> {
    const proc = Bun.spawn(["bun", "run", CHILD, checkout, cut, ...transcripts], {
        cwd: REPO,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    if (code !== 0) {
        throw new Error(`read-backward-child failed (exit ${code}) for ${checkout}: ${stderr.trim().slice(-500)}`);
    }

    const metrics: Record<string, number> = SafeJSON.parse(stdout.trim().split("\n").pop() ?? "{}", { strict: true });
    return metrics;
}

const runs: Array<Record<string, number>> = [];

for (let run = 0; run < args.warmup + args.runs; run++) {
    const merged: Record<string, number> = {};

    for (const arm of run % 2 === 0 ? arms : [...arms].reverse()) {
        for (const [key, value] of Object.entries(await sample(arm.checkout))) {
            merged[`${arm.name}.${key}`] = value;
        }
    }

    if (run >= args.warmup) {
        runs.push(merged);
    }
}

for (const run of runs) {
    for (const key of Object.keys(run)) {
        const [, shape, field] = key.split(".");

        if (before && key.startsWith("current.") && (field === "entries" || field === "found")) {
            const other = run[`before.${shape}.${field}`];

            if (other !== run[key]) {
                throw new Error(`check failed: ${key} = ${run[key]} but before.${shape}.${field} = ${other}`);
            }
        }
    }
}

await finishBench({
    name: BASELINE_NAME,
    title: "readSessionBackward on real Claude transcripts (CPU ms, median)",
    args,
    runs,
    lowerIsBetter: Object.keys(runs[0] ?? {}).filter((key) => key.endsWith("Ms")),
    floor: Object.fromEntries(Object.keys(runs[0] ?? {}).map((key) => [key, key.endsWith("Ms") ? 10 : 0])),
    notes: `${transcripts.length} live Claude transcripts, read-only; cut ${cut}${before ? `; before = ${before}` : ""}`,
    context: { transcripts, cut, arms },
});
