import { Database } from "bun:sqlite";
import { describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { createNativeHistoryAdapter } from "../native-adapter";
import { BASELINE_REVISION, type BaselineOracle, createBaselineOracle } from "./baseline-oracle";
import { generateHistoryCorpus } from "./corpus";
import { createFixtureWorld } from "./fixture-world";
import { withBaseline } from "./with-baseline";

describe("pinned history baseline oracle", () => {
    withBaseline(
        "runs legacy content search from the immutable source revision",
        async () => {
            const world = await createFixtureWorld();
            let oracle: BaselineOracle | undefined;
            try {
                const corpus = await generateHistoryCorpus({
                    root: world.root,
                    seed: 19,
                    sessionCount: 2,
                    recordCount: 4,
                    distribution: { main: 1, subagent: 1 },
                });
                oracle = await createBaselineOracle({ world });
                expect(BASELINE_REVISION).toBe("010697b869a34af0e79363b5c74bfc4946f74b96");
                expect(oracle.manifest.sourceHashes["src/claude/lib/history/search.ts"]).toBe(
                    "6cdb7b2b00b968af35afd0a666525519a4f841ba33f8d3eb59f5dc4a108534d1"
                );
                expect(oracle.manifest.runtimeBundleSha256).toMatch(/^[0-9a-f]{64}$/);
                expect(oracle.manifest.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
                expect(oracle.manifest.runtimeDependencyHash).toMatch(/^[0-9a-f]{64}$/);
                expect(Object.keys(oracle.manifest.runtimeDependencies).length).toBeGreaterThan(0);
                expect(oracle.startupMeasurement.materializeMs).toBeGreaterThanOrEqual(0);
                expect(oracle.startupMeasurement.driverStartMs).toBeGreaterThanOrEqual(0);
                expect(oracle.startupMeasurement.schemaInitMs).toBeGreaterThanOrEqual(0);
                expect(existsSync(world.databases.legacy)).toBe(true);
                expect(oracle.databasePath).toBe(world.databases.legacy);

                const results = await oracle.searchContent({ query: "seed-19", limit: 1 });
                expect(results.map((result) => result.sessionId)).toEqual([corpus.sessions[0]?.sessionId]);
                expect(results[0]?.isSubagent).toBe(false);
                expect(results[0]?.timestamp).toBeInstanceOf(Date);
                const firstMeasured = await oracle.measureSearchContent({ query: "seed-19", limit: 1 });
                const secondMeasured = await oracle.measureSearchContent({ query: "seed-19", limit: 1 });
                expect(firstMeasured.measurement.driverPid).toBe(secondMeasured.measurement.driverPid);
                expect(firstMeasured.measurement.elapsedMs).toBeGreaterThanOrEqual(0);
                expect(firstMeasured.measurement.cpuUserMicros).toBeGreaterThanOrEqual(0);
                expect(firstMeasured.measurement.cpuSystemMicros).toBeGreaterThanOrEqual(0);
                expect(firstMeasured.measurement.peakRssBytes).toBeGreaterThan(0);
                // Regression: Bun reports bytes; multiplying again made this two-session fixture report 100+ GB.
                expect(firstMeasured.measurement.peakRssBytes).toBeLessThan(1_000_000_000);
                await expect(oracle.probeFailure("fixture failure")).rejects.toThrow("fixture failure");
                const recovered = await oracle.measureSearchContent({ query: "seed-19", limit: 1 });
                expect(recovered.measurement.driverPid).toBe(firstMeasured.measurement.driverPid);
                const firstCold = await oracle.buildFreshProcessInvocation({
                    request: { operation: "content", filters: { query: corpus.queries.rare } },
                    cacheNamespace: "cold-a",
                });
                const secondCold = await oracle.buildFreshProcessInvocation({
                    request: { operation: "content", filters: { query: corpus.queries.rare } },
                    cacheNamespace: "cold-b",
                });
                expect(firstCold.command).toEqual(secondCold.command);
                expect(firstCold.cwd).toBe(secondCold.cwd);
                expect(firstCold.databasePath).not.toBe(secondCold.databasePath);
                const coldChild = Bun.spawn(firstCold.command, {
                    cwd: firstCold.cwd,
                    env: firstCold.environment,
                    stdin: new TextEncoder().encode(firstCold.stdin),
                    stdout: "pipe",
                    stderr: "pipe",
                });
                const [coldStdout, coldStderr, coldExit] = await Promise.all([
                    new Response(coldChild.stdout).text(),
                    new Response(coldChild.stderr).text(),
                    coldChild.exited,
                ]);
                expect(coldExit).toBe(0);
                expect(coldStderr).not.toContain("Baseline oracle failed");
                expect(coldStdout).toContain(firstCold.resultPrefix);
                const invalidFresh = await oracle.buildFreshProcessInvocation({
                    request: { operation: "probe-failure", message: "fixture failure" },
                    cacheNamespace: "cold-invalid",
                });
                const invalidChild = Bun.spawn(invalidFresh.command, {
                    cwd: invalidFresh.cwd,
                    env: invalidFresh.environment,
                    stdin: new TextEncoder().encode(invalidFresh.stdin),
                    stdout: "pipe",
                    stderr: "pipe",
                });
                const [invalidStdout, invalidExit] = await Promise.all([
                    new Response(invalidChild.stdout).text(),
                    invalidChild.exited,
                    new Response(invalidChild.stderr).text(),
                ]);
                expect(invalidExit).toBe(1);
                expect(invalidStdout).toContain(invalidFresh.resultPrefix);

                const secondCacheHome = join(world.root, "persistent-caches", "second-instance");
                const isolatedOracle = await createBaselineOracle({ world, cacheHome: secondCacheHome });
                expect(isolatedOracle.databasePath).toBe(
                    join(world.assertOwnedPath(secondCacheHome), ".genesis-tools", "claude-history", "index.db")
                );
                expect(isolatedOracle.databasePath).not.toBe(oracle.databasePath);
                expect(isolatedOracle.manifest.runtimeBundleSha256).toBe(oracle.manifest.runtimeBundleSha256);
                expect((await isolatedOracle.searchContent({ query: corpus.queries.rare }))[0]?.sessionId).toBe(
                    corpus.sessions[0]?.sessionId
                );
                await isolatedOracle.close();
                await Bun.write(firstCold.command[1]!, "corrupted fixture bundle\n");
                await expect(createBaselineOracle({ world, cacheHome: secondCacheHome })).rejects.toThrow(
                    "bundle hash mismatch"
                );
            } finally {
                await oracle?.close();
                await world.dispose();
            }
        },
        30_000
    );
});

withBaseline("exposes list, summary, detail, and statistics production DTOs", async () => {
    const world = await createFixtureWorld();
    let oracle: BaselineOracle | undefined;
    try {
        const corpus = await generateHistoryCorpus({
            root: world.root,
            seed: 23,
            sessionCount: 2,
            recordCount: 6,
            distribution: { main: 1, subagent: 1 },
        });
        oracle = await createBaselineOracle({ world });
        const listing = await oracle.list({ excludeAgents: true });
        const summaries = await oracle.searchSummaries({ query: "seed-23" });
        const detail = await oracle.getSelectedDetail(corpus.sessions[0]!.sessionId);
        const statistics = await oracle.getStatistics();

        expect(listing.map((result) => result.sessionId)).toEqual([corpus.sessions[0]!.sessionId]);
        expect(summaries.map((result) => result.sessionId)).toEqual([corpus.sessions[0]!.sessionId]);
        expect(detail?.matchedMessages).toHaveLength(3);
        expect(statistics.totalConversations).toBe(2);
        expect(statistics.totalMessages).toBe(6);
        expect(statistics.subagentCount).toBe(1);
    } finally {
        await oracle?.close();
        await world.dispose();
    }
});

withBaseline("shared adapter fixes the recorded main-first mismatch against the frozen baseline", async () => {
    const world = await createFixtureWorld();
    const database = new Database(":memory:");
    let oracle: BaselineOracle | undefined;
    try {
        const corpus = await generateHistoryCorpus({
            root: world.root,
            seed: 29,
            sessionCount: 2,
            recordCount: 4,
            distribution: { main: 1, subagent: 1 },
        });
        oracle = await createBaselineOracle({ world });
        const baseline = await oracle.searchContent({ query: "seed-29", limit: 1 });
        const current = await createNativeHistoryAdapter({
            kind: "claude",
            roots: [world.sources.claude],
            database,
        }).search({ query: "seed-29", limit: 1 });

        expect(baseline.map((result) => result.sessionId)).toEqual([corpus.sessions[0]!.sessionId]);
        expect(current.map((result) => result.sessionId)).toEqual(baseline.map((result) => result.sessionId));
    } finally {
        await oracle?.close();
        database.close();
        await world.dispose();
    }
});

withBaseline("shared adapter retains the original context that the retired normalized engine omitted", async () => {
    const world = await createFixtureWorld();
    const database = new Database(":memory:");
    let oracle: BaselineOracle | undefined;
    try {
        const sessionId = "11111111-2222-4333-8444-555555555555";
        const project = join(world.sources.claude, "-fixtures-context");
        const path = join(project, `${sessionId}.jsonl`);
        await mkdir(project, { recursive: true });
        const records = [
            { type: "progress", data: { message: "setup" } },
            {
                type: "user",
                sessionId,
                cwd: "/fixtures/context",
                timestamp: "2026-08-15T10:00:00.000Z",
                message: { role: "user", content: "find context-needle" },
            },
            { type: "summary", summary: "retained summary" },
            { type: "custom-title", customTitle: "retained title" },
            { type: "file-history-snapshot", snapshot: { trackedFileBackups: {} } },
        ];
        await writeFile(path, `${records.map((record) => SafeJSON.stringify(record)).join("\n")}\n`, "utf8");
        oracle = await createBaselineOracle({ world });
        const baseline = await oracle.searchContent({ query: "context-needle", context: 4 });
        const current = await createNativeHistoryAdapter({
            kind: "claude",
            roots: [world.sources.claude],
            database,
        }).search({ query: "context-needle", context: 4 });
        const currentTypes = (current[0]?.sourceRecords ?? []).map(
            (record) => (SafeJSON.parse(record.data, { strict: true }) as { type: string }).type
        );

        expect(baseline[0]?.contextMessages?.map((message) => message.type)).toEqual([
            "progress",
            "user",
            "summary",
            "custom-title",
            "file-history-snapshot",
        ]);
        expect(currentTypes).toEqual(baseline[0]?.contextMessages?.map((message) => message.type) ?? []);
    } finally {
        await oracle?.close();
        database.close();
        await world.dispose();
    }
});

// Regression test: T3 large benchmark stall — one oversized persistent-driver response blocked the queue.
withBaseline(
    "persistent transport drains a large response before the next request",
    async () => {
        const repositoryRoot = resolve(import.meta.dir, "../../../..");
        const helper = `
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { createBaselineOracle } from "./src/utils/agent-sessions/testing/baseline-oracle.ts";
import { createFixtureWorld } from "./src/utils/agent-sessions/testing/fixture-world.ts";

const world = await createFixtureWorld();
world.environment.BASELINE_PROTOCOL_DEBUG = "1";
let oracle;
try {
    oracle = await createBaselineOracle({ world });
    const probe = await oracle.measureList({ limit: 1 });
    console.log("DRIVER_PID:" + probe.measurement.driverPid);
    const sessionId = "11111111-2222-4333-8444-555555555555";
    const project = join(world.sources.claude, "-fixtures-transport");
    await mkdir(project, { recursive: true });
    const customTitle = "Z".repeat(16 * 1024 * 1024);
    await writeFile(
        join(project, sessionId + ".jsonl"),
        SafeJSON.stringify({ type: "custom-title", customTitle, sessionId }, { strict: true }) + "\\n",
        "utf8"
    );
    const large = await oracle.measureList({ limit: Number.MAX_SAFE_INTEGER });
    console.log("LARGE_DONE:" + large.value[0].customTitle.length + ":" + Math.round(large.measurement.elapsedMs));
    const next = await oracle.measureSearchSummaries({ query: "definitely-absent-transport-query" });
    console.log("NEXT_DONE:" + next.value.length);
} finally {
    await oracle?.close();
    await world.dispose();
}
`;
        const child = Bun.spawn(["bun", "-e", helper], {
            cwd: repositoryRoot,
            env: process.env,
            stdout: "pipe",
            stderr: "pipe",
        });
        let stdout = "";
        let timedOut = false;
        const stdoutDrain = (async () => {
            const reader = child.stdout.getReader();
            const decoder = new TextDecoder();
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) {
                    stdout += decoder.decode();
                    return;
                }
                stdout += decoder.decode(chunk.value, { stream: true });
            }
        })();
        const stderr = new Response(child.stderr).text();
        const watchdog = setTimeout(() => {
            timedOut = true;
            const driverPid = Number(stdout.match(/DRIVER_PID:(\\d+)/)?.[1]);
            if (Number.isSafeInteger(driverPid) && driverPid > 0) {
                try {
                    process.kill(driverPid, "SIGTERM");
                } catch {
                    child.kill();
                }
            } else {
                child.kill();
            }
        }, 15_000);
        const [, errorText, exitCode] = await Promise.all([stdoutDrain, stderr, child.exited]);
        clearTimeout(watchdog);

        if (timedOut) {
            throw new Error(`Transport watchdog fired\nstdout:\n${stdout}\nstderr:\n${errorText}`);
        }
        expect(exitCode).toBe(0);
        expect(errorText).toBe("");
        expect(stdout).toContain("LARGE_DONE:16777216:");
        expect(stdout).toContain("NEXT_DONE:0");
    },
    25_000
);

// Regression test: interleaved compact metadata reads stalled the next persistent baseline request.
withBaseline(
    "persistent transport survives interleaved compact metadata synchronization",
    async () => {
        const repositoryRoot = resolve(import.meta.dir, "../../../..");
        const helper = `
import { Database } from "bun:sqlite";
import { claudeHistoryReader } from "./src/utils/agent-sessions/compact-readers.ts";
import { initializeCompactHistorySchema } from "./src/utils/agent-sessions/migrations.ts";
import { HistoryService } from "./src/utils/agent-sessions/service.ts";
import { HistorySyncRepository } from "./src/utils/agent-sessions/sync-repository.ts";
import { createBaselineOracle } from "./src/utils/agent-sessions/testing/baseline-oracle.ts";
import { generateHistoryCorpus } from "./src/utils/agent-sessions/testing/corpus.ts";
import { createFixtureWorld } from "./src/utils/agent-sessions/testing/fixture-world.ts";

const world = await createFixtureWorld();
const database = new Database(world.databases.candidate);
initializeCompactHistorySchema(database);
const service = new HistoryService({
    providerId: "anthropic-sub",
    reader: claudeHistoryReader,
    repository: new HistorySyncRepository(database),
    roots: [world.sources.claude],
    now: () => world.now,
});
let oracle;
try {
    const corpus = await generateHistoryCorpus({
        root: world.root,
        seed: 20_260_907,
        sessionCount: 20,
        recordCount: 200,
        distribution: { main: 10, subagent: 10 },
        now: world.now,
    });
    oracle = await createBaselineOracle({ world });
    const first = await oracle.measureList({ limit: Number.MAX_SAFE_INTEGER });
    console.log("DRIVER_PID:" + first.measurement.driverPid);
    await service.sync();
    await oracle.measureSearchSummaries({ query: corpus.queries.common, limit: 20 });
    await service.search({ query: corpus.queries.common, limit: 20, summaryOnly: true });
    const rare = await oracle.measureSearchContent({ query: corpus.queries.rare, limit: 20 });
    console.log("INTERLEAVED_DONE:" + rare.value.length);
} finally {
    await oracle?.close();
    database.close();
    await world.dispose();
}
`;
        const child = Bun.spawn(["bun", "-e", helper], {
            cwd: repositoryRoot,
            env: process.env,
            stdout: "pipe",
            stderr: "pipe",
        });
        const stdout = new Response(child.stdout).text();
        const stderr = new Response(child.stderr).text();
        let timedOut = false;
        const watchdog = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, 15_000);
        const [output, errorText, exitCode] = await Promise.all([stdout, stderr, child.exited]);
        clearTimeout(watchdog);

        if (timedOut) {
            throw new Error(`Interleaved transport watchdog fired\nstdout:\n${output}\nstderr:\n${errorText}`);
        }
        expect(exitCode).toBe(0);
        expect(errorText).not.toContain("Baseline oracle failed");
        expect(output).toContain("INTERLEAVED_DONE:1");
    },
    25_000
);
