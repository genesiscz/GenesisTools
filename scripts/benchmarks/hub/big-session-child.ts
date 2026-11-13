#!/usr/bin/env bun
/**
 * One fresh process that answers, as the resident hub server does, the calls the hub makes when a session is
 * selected: each call goes through its door (`HUB_SERVER_DOORS`), in this process and on this event loop. Prints one
 * JSON object of metrics on stdout. Driven by `big-session.ts`; run alone to look at one sample.
 *
 *   bun big-session-child.ts <checkout> <session id> each|together
 *
 * `each`: every call alone, twice. The first is what a server pays after a start (`cold`), the second what it pays
 * on a refresh (`warm`). `together`: every call at once, as a selection sends them; `together.tailAnswerMs` is how
 * long the cheapest one (the transcript's last page) waits behind the others, `together.maxStallMs` is the
 * longest time the event loop answered nobody, and `together.failed` counts the calls that failed beside the others.
 *
 * The modules are imported from `<checkout>`, so another worktree's copy (an older commit) runs its own code.
 * Nothing here writes the object store: the Changes call runs without `--store-blobs`.
 */
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

const [checkout, session, mode] = process.argv.slice(2);

if (!checkout || !session || (mode !== "each" && mode !== "together")) {
    process.stderr.write("usage: big-session-child.ts <checkout> <session id> each|together\n");
    process.exit(2);
}

interface CallDoorLike {
    kind: string;
    name: string;
    match(argv: readonly string[]): unknown;
    run(parsed: unknown, ctx: { signal: AbortSignal }): Promise<{ stdout: string; stderr: string; exit: number }>;
}

const { HUB_SERVER_DOORS } = await import(join(checkout, "src/hub/server/doors/index.ts"));
const { monitorLoopStalls } = await import(join(checkout, "src/benchmark/lib/loop-stall.ts"));
const doors: CallDoorLike[] = HUB_SERVER_DOORS;

/** The calls of one selection, by a short name for the metrics. */
const CALLS: Array<{ key: string; argv: string[] }> = [
    { key: "tail", argv: ["ai", "sessions", "tail", session, "--json", "--limit", "12"] },
    { key: "subagents", argv: ["ai", "sessions", "subagents", session, "--json"] },
    { key: "changes", argv: ["agents", "changes", session, "--last-turns", "5", "--json"] },
    { key: "inbox", argv: ["question", "inbox", "--session", session, "--json"] },
    { key: "agents", argv: ["hub", "agents", "--json"] },
    { key: "usage", argv: ["ai", "usage", "sessions", "--json", "--hours", "72"] },
];
const TICK_MS = 20;
/** One door call that runs longer than this is stuck, not slow: its signal aborts it and the sample fails. */
const CALL_DEADLINE_MS = 5 * 60_000;
// The server always holds a listening socket; this timer stands in for it, so the loop of this process waits as the
// server's does while a worker thread has the work.
const keepAlive = setInterval(() => undefined, 1000);

function cpuMs(started: NodeJS.CpuUsage): number {
    const used = process.cpuUsage(started);
    return (used.user + used.system) / 1000;
}

async function answer(argv: string[]): Promise<{ exit: number; bytes: number }> {
    for (const door of doors) {
        if (door.kind !== "call") {
            continue;
        }

        const parsed = door.match(argv);
        if (parsed === null) {
            continue;
        }

        const result = await door.run(parsed, { signal: AbortSignal.timeout(CALL_DEADLINE_MS) });
        if (result.exit !== 0) {
            throw new Error(`${argv.slice(0, 3).join(" ")} exited ${result.exit}: ${result.stderr.trim().slice(-300)}`);
        }

        return { exit: result.exit, bytes: result.stdout.length };
    }

    throw new Error(`no door answers: ${argv.join(" ")}`);
}

const metrics: Record<string, number> = {};

if (mode === "each") {
    for (const call of CALLS) {
        for (const pass of ["cold", "warm"]) {
            const monitor = monitorLoopStalls({ tickMs: TICK_MS });
            const cpu = process.cpuUsage();
            const started = performance.now();
            const result = await answer(call.argv);
            metrics[`${call.key}.${pass}.wallMs`] = performance.now() - started;
            metrics[`${call.key}.${pass}.cpuMs`] = cpuMs(cpu);
            // One more tick, so a call that never gave the loop back is counted as one stall.
            await Bun.sleep(TICK_MS * 2);
            metrics[`${call.key}.${pass}.stallMs`] = monitor.stop().maxStallMs;
            if (pass === "cold") {
                metrics[`${call.key}.bytes`] = result.bytes;
            }
        }
    }
} else {
    const monitor = monitorLoopStalls({ tickMs: TICK_MS });
    const cpu = process.cpuUsage();
    const started = performance.now();
    metrics["together.failed"] = 0;
    await Promise.all(
        CALLS.map(async (call) => {
            try {
                await answer(call.argv);
                metrics[`together.${call.key}AnswerMs`] = performance.now() - started;
            } catch (error) {
                // A call that fails only beside the others is a finding, not a broken run: count it.
                metrics["together.failed"] += 1;
                process.stderr.write(`${call.key}: ${error instanceof Error ? error.message : String(error)}\n`);
            }
        })
    );
    metrics["together.wallMs"] = performance.now() - started;
    metrics["together.cpuMs"] = cpuMs(cpu);
    await Bun.sleep(TICK_MS * 2);
    metrics["together.maxStallMs"] = monitor.stop().maxStallMs;
}

// The kernel's high-water mark of the whole process (worker threads included), in KB: a sample taken after each
// answer missed the transient peak of a call whose buffers were already freed.
metrics[`${mode}.peakRssMb`] = Math.round(process.resourceUsage().maxRSS / 1024);
process.stdout.write(`${SafeJSON.stringify(metrics, { strict: true })}\n`);
clearInterval(keepAlive);
// A door may leave a watcher or a database handle open; the numbers are out, so the process ends here.
process.exit(0);
