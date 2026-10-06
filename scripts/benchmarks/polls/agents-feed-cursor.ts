#!/usr/bin/env bun
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeedLogCursor, readFeedSince } from "@app/agents/lib/feed";
import { ensureSessionDir, sessionPaths } from "@app/agents/lib/paths";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";

const events = Math.max(1, Number.parseInt(process.argv[2] ?? "1000", 10));
const iterations = Math.max(1, Number.parseInt(process.argv[3] ?? "200", 10));
const batches = Math.max(2, Number.parseInt(process.argv[4] ?? "20", 10));
const benchmarkHome = mkdtempSync(join(tmpdir(), "gt-agents-feed-cursor-"));
env.testing.set("GENESIS_TOOLS_HOME", benchmarkHome);
const paths = sessionPaths(`cursor-${process.pid}`);
ensureSessionDir(paths);

const lines = Array.from({ length: events }, (_, index) =>
    SafeJSON.stringify(
        {
            seq: index + 1,
            ts: new Date(index).toISOString(),
            type: "message",
            message_id: (index + 1).toString(16).padStart(4, "0"),
            from_agent_id: "main_benchmark",
            from_agent_name: "lead",
            to_agent_ids: ["agt_benchmark"],
            body: `benchmark message ${index}`,
            meta: {},
            private: false,
        },
        { strict: true }
    )
);
writeFileSync(paths.feedPath, `${lines.join("\n")}\n`);
const retainedBytes = statSync(paths.feedPath).size;

let cursorBytes = 0;
let cursorRecords = 0;
const cursor = new FeedLogCursor({
    paths,
    sinceSeq: 0,
    onRead: (sample) => {
        cursorBytes += sample.bytes;
        cursorRecords += sample.records;
    },
});
const initial = await cursor.readAppended();
if (initial.length !== events) {
    throw new Error(`cursor warmup returned ${initial.length}, expected ${events}`);
}
cursorBytes = 0;
cursorRecords = 0;

let baselineCpuUs = 0;
let candidateCpuUs = 0;

async function baselineBatch(): Promise<void> {
    const started = process.cpuUsage();
    for (let index = 0; index < iterations; index++) {
        const result = await readFeedSince(paths, events);
        if (result.length !== 0) {
            throw new Error(`baseline idle read returned ${result.length} events`);
        }
    }
    const used = process.cpuUsage(started);
    baselineCpuUs += used.user + used.system;
}

async function candidateBatch(): Promise<void> {
    const started = process.cpuUsage();
    for (let index = 0; index < iterations; index++) {
        const result = await cursor.readAppended();
        if (result.length !== 0) {
            throw new Error(`candidate idle read returned ${result.length} events`);
        }
    }
    const used = process.cpuUsage(started);
    candidateCpuUs += used.user + used.system;
}

for (let batch = 0; batch < batches; batch++) {
    if (batch % 2 === 0) {
        await baselineBatch();
        await candidateBatch();
    } else {
        await candidateBatch();
        await baselineBatch();
    }
}

const calls = iterations * batches;
out.result({
    events,
    retainedBytes,
    callsPerArm: calls,
    baseline: {
        cpuUs: baselineCpuUs,
        bytesParsed: retainedBytes * calls,
        recordsParsed: events * calls,
    },
    candidate: {
        cpuUs: candidateCpuUs,
        bytesParsed: cursorBytes,
        recordsParsed: cursorRecords,
    },
});
