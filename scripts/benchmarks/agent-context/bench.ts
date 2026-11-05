#!/usr/bin/env bun
/**
 * CPU time and spawned processes per call of every agent-context gatherer, in this process.
 *
 *   bun scripts/benchmarks/agent-context/bench.ts --baseline    # record the "before" numbers
 *   bun scripts/benchmarks/agent-context/bench.ts --compare     # diff a later run against it
 *   bun scripts/benchmarks/agent-context/bench.ts --iterations 10 --json
 *
 * WHAT IS MEASURED. Each gatherer runs `--iterations` times after two uncounted warm-up calls. CPU is this
 * process's user plus system time over the loop, divided by the iterations (`process.cpuUsage`), so it excludes the
 * CPU of children the gatherer starts: those show up in the spawn count instead, which `withSpawnCounter` takes over
 * the same loop (a count of `Bun.spawn` and `Bun.spawnSync` calls, a floor: `Bun.$` is invisible). Wall time is
 * printed for reading only and never recorded, because it swings with the machine's load.
 *
 * WHICH GATHERERS. The seven of `probe.ts`, plus the rest the agent-context profiler scope wraps: the failure
 * caller's transcript lookup, the say caller's ancestry walk, the gateway's peer lookup and the hook payload parser.
 * The numbers describe the shell or agent that runs the bench: run it from a Claude session for the Claude shape.
 */
import { loadavg } from "node:os";
import { parseHookPayload } from "@app/agents/lib/hooks/payload";
import {
    type BaselineMetrics,
    compareToBaseline,
    formatComparison,
    recordBaseline,
    withSpawnCounter,
} from "@app/benchmark/lib";
import { resolveCallerFromPeer } from "@app/genesis-tools-mcp/lib/http-caller";
import { captureAncestry, captureCallerContext } from "@app/say/lib/caller";
import { agentSessionIds, assignedSessionId, resolveAgentHost } from "@genesiscz/utils/agent/host";
import { gatherHarnessPoster, getAgentRuntimeContext } from "@genesiscz/utils/agent/runtime";
import { agentFailureCaller } from "@genesiscz/utils/cli/failures/agent-caller";
import { failureCaller, transcriptOf } from "@genesiscz/utils/cli/failures/caller";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";

const BASELINE_NAME = "agent-context-gatherers";
const DEFAULT_ITERATIONS = 20;
const WARMUP_CALLS = 2;
/** A peer lookup for ports nobody owns: it still pays for the `lsof` spawn and answers the unknown caller. */
const UNUSED_PORT = 1;

interface Gatherer {
    name: string;
    call: () => unknown;
}

interface Row {
    name: string;
    cpuMs: number;
    spawns: number;
    wallMs: number;
}

function flagValue(argv: string[], flag: string): string | null {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length && !argv[index + 1].startsWith("--") ? argv[index + 1] : null;
}

function buildGatherers(): Gatherer[] {
    const env = process.env;
    const context = getAgentRuntimeContext();
    const hookPayload = SafeJSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        session_id: "00000000-0000-4000-8000-000000000000",
        transcript_path: "/tmp/cc/agent-context-bench/transcript.jsonl",
        cwd: process.cwd(),
    });

    return [
        { name: "resolveAgentHost", call: () => resolveAgentHost(env) },
        { name: "agentSessionIds", call: () => agentSessionIds(env) },
        { name: "assignedSessionId", call: () => assignedSessionId(env) },
        { name: "getAgentRuntimeContext", call: () => getAgentRuntimeContext() },
        { name: "gatherHarnessPoster", call: () => gatherHarnessPoster() },
        { name: "agentFailureCaller", call: () => agentFailureCaller() },
        { name: "failureCaller", call: () => failureCaller({ context, processEnv: env }) },
        { name: "transcriptOf", call: () => transcriptOf({ context, processEnv: env }) },
        { name: "captureCallerContext (say)", call: () => captureCallerContext() },
        { name: "captureAncestry (say)", call: () => captureAncestry(process.ppid) },
        {
            name: "resolveCallerFromPeer",
            call: () => resolveCallerFromPeer({ clientPort: UNUSED_PORT, serverPort: UNUSED_PORT }),
        },
        { name: "parseHookPayload", call: () => parseHookPayload(hookPayload) },
    ];
}

async function measure(gatherer: Gatherer, iterations: number): Promise<Row> {
    for (let i = 0; i < WARMUP_CALLS; i++) {
        await gatherer.call();
    }

    const cpuBefore = process.cpuUsage();
    const wallBefore = performance.now();
    const { count } = await withSpawnCounter(async () => {
        for (let i = 0; i < iterations; i++) {
            await gatherer.call();
        }
    });
    const wallMs = performance.now() - wallBefore;
    const cpu = process.cpuUsage(cpuBefore);

    return {
        name: gatherer.name,
        cpuMs: (cpu.user + cpu.system) / 1000 / iterations,
        spawns: count / iterations,
        wallMs: wallMs / iterations,
    };
}

function metricsOf(rows: Row[]): BaselineMetrics {
    const metrics: BaselineMetrics = {};

    for (const row of rows) {
        metrics[`${row.name}.cpuMs`] = Math.round(row.cpuMs * 1000) / 1000;
        metrics[`${row.name}.spawns`] = Math.round(row.spawns * 100) / 100;
    }

    return metrics;
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const iterations = Number(flagValue(argv, "--iterations") ?? DEFAULT_ITERATIONS);
    const baselineName = flagValue(argv, "--baseline") ?? BASELINE_NAME;

    if (!Number.isInteger(iterations) || iterations < 1) {
        out.println("--iterations needs a whole number of at least 1.");
        process.exitCode = 2;
        return;
    }

    const rows: Row[] = [];

    for (const gatherer of buildGatherers()) {
        rows.push(await measure(gatherer, iterations));
    }

    const metrics = metricsOf(rows);

    if (argv.includes("--json")) {
        out.result({
            iterations,
            loadAvg: loadavg(),
            metrics,
            wallMs: Object.fromEntries(rows.map((r) => [r.name, r.wallMs])),
        });
    } else {
        renderCliHeader("Agent-context gatherers", `${iterations} calls each, after ${WARMUP_CALLS} warm-up calls`);
        const table = createBoxTable(["GATHERER", "CPU ms/call", "SPAWNS/call", "WALL ms/call"]);

        for (const row of rows) {
            table.push([row.name, row.cpuMs.toFixed(3), row.spawns.toFixed(2), row.wallMs.toFixed(2)]);
        }

        out.println(table.toString());
        out.println(
            `load average ${loadavg()
                .map((n) => n.toFixed(2))
                .join(" ")}`
        );
    }

    if (argv.includes("--baseline")) {
        const recorded = await recordBaseline({
            name: baselineName,
            metrics,
            notes: `${iterations} calls per gatherer in one process, run from ${process.env.TERM_PROGRAM ?? "a shell"}; CPU is this process only, children appear as spawns`,
        });
        out.println(`Recorded baseline "${recorded.name}" at commit ${recorded.commit}.`);
    }

    if (argv.includes("--compare")) {
        const comparison = await compareToBaseline({
            name: baselineName,
            metrics,
            tolerancePct: 25,
            floor: Object.fromEntries(rows.map((row) => [`${row.name}.cpuMs`, 0.5])),
        });
        out.println(formatComparison(comparison));
        process.exitCode = comparison.ok ? 0 : 1;
    }
}

await main();
