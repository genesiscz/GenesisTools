#!/usr/bin/env bun
/**
 * What the Claude sub-agent listing refresh costs: the read-only part of `getSessionListing({ subagentsOnly: true,
 * refresh: true })`, which the widget watch runs on every burst of sub-agent transcript writes (12,456 sub-agent
 * transcripts in 4,572 folders here, 2026-10-27): the discovery walk (`agentsOnly`) and the candidate pass that takes
 * each file's mtime. `*.warmMs` is what the resident watch pays per burst; `*.coldMs` a fresh process.
 *
 * ARMS, interleaved per run, each a fresh process (`agents-listing-child.ts`): `current` is this checkout;
 * `--before <checkout>` adds a second checkout (a worktree at an older commit) whose own code runs. `sources`,
 * `sourcesHash`, `candidates` and `issues` are the check: both arms must find the same files.
 *
 * The roots are the live ones on this Mac (read-only), so record the baseline and the comparison close together.
 *
 * Usage:
 *   bun scripts/benchmarks/agent-sessions/agents-listing.ts --runs 5 --before /tmp/cc/<project>/<session>/worktrees/before
 *   bun scripts/benchmarks/agent-sessions/agents-listing.ts --baseline | --compare
 */
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { finishBench, parseBenchArgs } from "../fs/shared";

const BASELINE_NAME = "agent-sessions-agents-listing";
const REPO = join(import.meta.dir, "..", "..", "..");
const CHILD = join(import.meta.dir, "agents-listing-child.ts");
const args = parseBenchArgs(process.argv.slice(2));
const beforeAt = process.argv.indexOf("--before");
const before = beforeAt > 0 ? process.argv[beforeAt + 1] : undefined;
const arms: Array<{ name: string; checkout: string }> = [
    { name: "current", checkout: REPO },
    ...(before ? [{ name: "before", checkout: before }] : []),
];
const CHECKED = ["sources", "sourcesHash", "candidates", "issues", "completeRoots"];

async function sample(checkout: string): Promise<Record<string, number>> {
    const proc = Bun.spawn(["bun", "run", CHILD, checkout, "8"], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    if (code !== 0) {
        throw new Error(`agents-listing-child failed (exit ${code}) for ${checkout}: ${stderr.trim().slice(-500)}`);
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
    for (const field of CHECKED) {
        if (before && run[`current.${field}`] !== run[`before.${field}`]) {
            throw new Error(
                `check failed: current.${field} = ${run[`current.${field}`]} but before.${field} = ${run[`before.${field}`]}`
            );
        }
    }
}

await finishBench({
    name: BASELINE_NAME,
    title: "Claude sub-agent listing refresh, read-only part (CPU ms, median)",
    args,
    runs,
    lowerIsBetter: Object.keys(runs[0] ?? {}).filter((key) => key.endsWith("Ms")),
    floor: Object.fromEntries(Object.keys(runs[0] ?? {}).map((key) => [key, key.endsWith("Ms") ? 10 : 0])),
    notes: `live Claude roots, read-only${before ? `; before = ${before}` : ""}`,
    context: { arms },
});
