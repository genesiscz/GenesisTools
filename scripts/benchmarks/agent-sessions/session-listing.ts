#!/usr/bin/env bun
/**
 * What the session list costs: `tools ai usage sessions --json --hours 24 --min 10`, the query Genesis.app and
 * the hub poll, plus each provider's discovery on its own.
 *
 * ARMS, interleaved per run:
 *   - `cli.fresh`: the whole command with `--fresh --no-cache-write`, as the daemon's per-minute refresh runs it
 *     when the hub server does not answer. CPU is the child's own rusage.
 *   - `cli.cached`: the whole command without `--fresh`, as a reader that hits the rows cache pays it.
 *   - `discover-child.ts`: each provider's discovery in a fresh process, cold (first pass, what a CLI process
 *     pays) and warm (second pass, what the resident hub server pays with its folder-listing cache).
 *
 * The roots are the live ones on this Mac (read-only), so the numbers move as sessions accumulate: record the
 * baseline and the comparison close together, and read `*.sources` beside every CPU number.
 *
 * Usage:
 *   bun scripts/benchmarks/agent-sessions/session-listing.ts --baseline
 *   bun scripts/benchmarks/agent-sessions/session-listing.ts --compare
 *   bun scripts/benchmarks/agent-sessions/session-listing.ts --runs 7 --json
 */
import { join } from "node:path";
import type { BaselineMetrics } from "@app/benchmark/lib";
import { SafeJSON } from "@genesiscz/utils/json";
import { finishBench, parseBenchArgs } from "../fs/shared";

const BASELINE_NAME = "agent-sessions-listing";
const REPO = join(import.meta.dir, "..", "..", "..");
const LISTING = ["usage", "sessions", "--json", "--hours", "24", "--min", "10"];

async function cliRun(extra: string[]): Promise<{ cpuMs: number; wallMs: number }> {
    const started = performance.now();
    const proc = Bun.spawn(["bun", "run", join(REPO, "src/ai/index.ts"), ...LISTING, ...extra], {
        cwd: REPO,
        stdout: "ignore",
        stderr: "ignore",
    });
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        throw new Error(`usage sessions ${extra.join(" ")} exited ${exitCode}`);
    }

    return { cpuMs: Number(proc.resourceUsage()?.cpuTime.total ?? 0) / 1000, wallMs: performance.now() - started };
}

async function discoverSample(): Promise<Record<string, number>> {
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "discover-child.ts")], {
        cwd: REPO,
        stdout: "pipe",
        stderr: "ignore",
    });
    const [text, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

    if (exitCode !== 0) {
        throw new Error(`discover-child exited ${exitCode}`);
    }

    return SafeJSON.parse(text, { strict: true }) as Record<string, number>;
}

const args = parseBenchArgs(process.argv.slice(2));
const runs: BaselineMetrics[] = [];

for (let i = 0; i < args.warmup + args.runs; i++) {
    const fresh = await cliRun(["--fresh", "--no-cache-write"]);
    const cached = await cliRun([]);
    const metrics: BaselineMetrics = {
        "cli.fresh.cpuMs": fresh.cpuMs,
        "cli.fresh.wallMs": fresh.wallMs,
        "cli.cached.cpuMs": cached.cpuMs,
        ...(await discoverSample()),
    };

    if (i >= args.warmup) {
        runs.push(metrics);
    }
}

await finishBench({
    name: BASELINE_NAME,
    title: "Session listing: whole command and per-provider discovery (CPU ms, median)",
    args,
    runs,
    lowerIsBetter: Object.keys(runs[0] ?? {}).filter((key) => key.endsWith("Ms")),
    floor: Object.fromEntries(Object.keys(runs[0] ?? {}).map((key) => [key, key.endsWith("Ms") ? 15 : 0])),
    notes: "live session roots on this Mac, read-only; discover = excludeAgents listing scope",
    context: { listing: LISTING },
});
