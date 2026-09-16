#!/usr/bin/env bun
/**
 * Baseline for `sendRequest`'s reply wait — `src/agents/lib/request.ts:38`.
 *
 * The loop calls `readFeedSince(paths, seq)` every 20 ms, and `readFeedSince`
 * re-reads and re-parses the WHOLE feed file each time before filtering
 * (`src/agents/lib/feed.ts:37-40`). A session with a few thousand events
 * therefore re-parses hundreds of kilobytes fifty times a second while waiting
 * for one line that has not arrived.
 *
 * WHAT IS REAL HERE. The real `sendRequest`, against a real feed file, for the
 * full timeout. The reads are counted by intercepting `Bun.file`, which
 * `readJsonlFile` (`src/utils/log-session/jsonl-reader.ts:10`) reads off the
 * `Bun` object at call time, so the count comes from the function under test
 * rather than from a re-implementation of its loop.
 *
 * WHAT IS NOT COUNTED. `withFsCounter` sees nothing here and the script does not
 * use it: `readFeed`'s `existsSync` is an ESM NAMED import, which binds to the
 * function value at import time and cannot be reached by patching the `node:fs`
 * module object. `Bun.file` is the byte-moving call anyway, so the read count is
 * exact rather than a floor.
 *
 * The fixture feed is written in one `writeFileSync` rather than through
 * `appendFeed`, which re-reads the whole file under a lock per append and is
 * quadratic in the fixture size. The event shapes are the real `FeedEvent`
 * union, so a shape drift is a type error rather than a silent no-match.
 */
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendRequest } from "@app/agents/lib/request";
import type { FeedEvent } from "@app/agents/lib/types";
import { type BaselineMetrics, sampleSelf } from "@app/benchmark/lib";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import { addCommonOptions, type CommonFlags, runPollBenchmark } from "./harness";

const SENDER_ID = "agt_0001";
const SENDER_NAME = "bench-sender";
const RECIPIENT_ID = "agt_0002";
const RECIPIENT_NAME = "bench-recipient";

interface Fixture {
    session: string;
    feedPath: string;
    feedBytes: number;
}

/** Build the fixture feed: two registered agents, then filler messages nobody replies to. */
function createFeed(lines: number): Fixture {
    const home = mkdtempSync(join(tmpdir(), "gt-bench-request-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);

    const session = `bench-${Date.now()}`;
    const sessionDir = join(home, ".genesis-tools", "agents", session);
    mkdirSync(join(sessionDir, "slots"), { recursive: true });

    const ts = new Date().toISOString();
    const events: FeedEvent[] = [
        {
            type: "registered",
            agent_name: SENDER_NAME,
            agent_id: SENDER_ID,
            awaiting_login: false,
            is_main: false,
            role: null,
            meta: {},
            seq: 1,
            ts,
        },
        {
            type: "registered",
            agent_name: RECIPIENT_NAME,
            agent_id: RECIPIENT_ID,
            awaiting_login: false,
            is_main: false,
            role: null,
            meta: {},
            seq: 2,
            ts,
        },
    ];

    for (let i = events.length; i < lines; i++) {
        events.push({
            type: "message",
            message_id: (i - 1).toString(16).padStart(4, "0"),
            from_agent_id: RECIPIENT_ID,
            from_agent_name: RECIPIENT_NAME,
            to_agent_ids: [SENDER_ID],
            body: `filler event ${i} — a realistic message body, long enough that parsing it costs something`,
            meta: {},
            private: false,
            seq: i + 1,
            ts,
        });
    }

    const feedPath = join(sessionDir, "feed.jsonl");
    writeFileSync(feedPath, `${events.map((event) => SafeJSON.stringify(event, { strict: true })).join("\n")}\n`);

    return { session, feedPath, feedBytes: statSync(feedPath).size };
}

type AnyFn = (...args: unknown[]) => unknown;

/** Count `Bun.file(feedPath)` calls for the duration of `fn`, then restore the patch. */
async function withFeedReadCounter<T>(feedPath: string, fn: () => Promise<T>): Promise<{ result: T; reads: number }> {
    const savedFile = Bun.file;
    const callFile = savedFile as unknown as AnyFn;
    let reads = 0;

    Bun.file = ((...args: unknown[]) => {
        if (args[0] === feedPath) {
            reads += 1;
        }

        return callFile(...args);
    }) as unknown as typeof Bun.file;

    try {
        return { result: await fn(), reads };
    } finally {
        Bun.file = savedFile;
    }
}

async function measure(lines: number, timeoutMs: number): Promise<BaselineMetrics> {
    const fixture = createFeed(lines);
    const startedAt = performance.now();
    const [counted, sample] = await Promise.all([
        withFeedReadCounter(fixture.feedPath, async () => {
            try {
                await sendRequest({
                    session: fixture.session,
                    from: SENDER_NAME,
                    to: RECIPIENT_NAME,
                    body: "benchmark request that is never answered",
                    timeoutMs,
                });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);

                if (!message.includes("timed out")) {
                    throw err;
                }
            }

            return null;
        }),
        sampleSelf({ windowMs: timeoutMs, countThreads: false }),
    ]);
    const elapsedSec = (performance.now() - startedAt) / 1000;
    // The append under withFeedLock reads the feed once before the wait starts.
    // Both rates describe the WAIT loop, so both exclude that setup read.
    const waitReads = Math.max(0, counted.reads - 1);

    return {
        feedReads: counted.reads,
        readsPerSec: Number((waitReads / elapsedSec).toFixed(2)),
        bytesParsedPerSec: Math.round((waitReads * fixture.feedBytes) / elapsedSec),
        cpuPercent: Number(sample.cpuPercent.toFixed(2)),
    };
}

const program = addCommonOptions(
    new Command()
        .name("agents-request-wait")
        .description("Measure the full-feed re-parse in sendRequest's 20 ms reply wait")
        .option("--lines <n>", "How many events the fixture feed holds", "2000")
        .option("--timeout-ms <ms>", "How long the unanswered request waits", "3000")
);
await program.parseAsync(process.argv);
const flags = program.opts<CommonFlags & { lines: string; timeoutMs: string }>();
const lines = Math.max(2, Number.parseInt(flags.lines, 10) || 2000);
const timeoutMs = Math.max(100, Number.parseInt(flags.timeoutMs, 10) || 3000);

out.log.info(`Each run waits ${timeoutMs} ms on a ${lines}-event feed that never receives a reply.`);

await runPollBenchmark({
    stem: "agents-request-wait",
    title: "agents sendRequest() — the whole feed re-parsed every 20 ms",
    setup: `real sendRequest, ${lines}-event temp feed, ${timeoutMs} ms timeout, no reply`,
    flags,
    measure: () => measure(lines, timeoutMs),
});
