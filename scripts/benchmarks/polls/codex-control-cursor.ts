#!/usr/bin/env bun
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendControlRequest, ControlLogCursor, readControlRequests } from "@app/codex/lib/control-channel";
import { sessionControlPath } from "@app/codex/lib/paths";
import { env } from "@genesiscz/utils/env";
import { out } from "@genesiscz/utils/logger";

const requests = Math.max(1, Number.parseInt(process.argv[2] ?? "160", 10));
const iterations = Math.max(1, Number.parseInt(process.argv[3] ?? "200", 10));
const batches = Math.max(2, Number.parseInt(process.argv[4] ?? "20", 10));
const generation = "benchmark";
const benchmarkHome = mkdtempSync(join(tmpdir(), "gt-codex-control-cursor-"));
env.testing.set("GENESIS_TOOLS_HOME", benchmarkHome);
const name = `cursor-${process.pid}`;

for (let index = 0; index < requests; index++) {
    await appendControlRequest(name, generation, {
        op: "steer",
        body: `benchmark control ${index} ${"x".repeat(1024)}`,
        force: false,
    });
}

const path = sessionControlPath(name);
const retainedBytes = statSync(path).size;
let cursorBytes = 0;
let cursorRecords = 0;
const cursor = new ControlLogCursor({
    name,
    generation,
    onRead: (sample) => {
        cursorBytes += sample.bytes;
        cursorRecords += sample.records;
    },
});
const initial = await cursor.readAppendedRequests();
if (initial.length !== requests) {
    throw new Error(`cursor warmup returned ${initial.length}, expected ${requests}`);
}
cursorBytes = 0;
cursorRecords = 0;

let baselineCpuUs = 0;
let candidateCpuUs = 0;

async function baselineBatch(): Promise<void> {
    const started = process.cpuUsage();
    for (let index = 0; index < iterations; index++) {
        const result = await readControlRequests(name, requests, generation);
        if (result.length !== 0) {
            throw new Error(`baseline idle read returned ${result.length} controls`);
        }
    }
    const used = process.cpuUsage(started);
    baselineCpuUs += used.user + used.system;
}

async function candidateBatch(): Promise<void> {
    const started = process.cpuUsage();
    for (let index = 0; index < iterations; index++) {
        const result = await cursor.readAppendedRequests();
        if (result.length !== 0) {
            throw new Error(`candidate idle read returned ${result.length} controls`);
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
    requests,
    retainedBytes,
    callsPerArm: calls,
    baseline: {
        cpuUs: baselineCpuUs,
        bytesParsed: retainedBytes * calls,
        recordsParsed: requests * calls,
    },
    candidate: {
        cpuUs: candidateCpuUs,
        bytesParsed: cursorBytes,
        recordsParsed: cursorRecords,
    },
});
