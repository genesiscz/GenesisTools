import type { LogEntry, RunSummary } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { mockDashboardClient } from "@/api/mock-client";
import {
    BACKLOG_LIMIT,
    buildLogBacklogQuery,
    buildLogKeys,
    buildLogRunsQuery,
    RUNS_INTERVAL_MS,
    RUNS_LIMIT,
} from "@/features/build-log-tail/queries";

describe("build-log-tail query factories", () => {
    it("buildLogRunsQuery builds the runs key + interval, returns the mock fixture runs", async () => {
        const opts = buildLogRunsQuery(mockDashboardClient);
        expect([...opts.queryKey]).toEqual([...buildLogKeys.runs(RUNS_LIMIT)]);
        expect(opts.refetchInterval).toBe(RUNS_INTERVAL_MS);
        const data = await (opts.queryFn as unknown as () => Promise<RunSummary[]>)();
        expect(Array.isArray(data)).toBe(true);
        expect(data.length).toBeGreaterThan(0);
    });

    it("buildLogBacklogQuery is disabled with no logFile, keyed by logFile otherwise", async () => {
        const disabled = buildLogBacklogQuery(mockDashboardClient, null);
        expect(disabled.enabled).toBe(false);
        expect([...disabled.queryKey]).toEqual([...buildLogKeys.backlog("")]);

        const enabled = buildLogBacklogQuery(mockDashboardClient, "sync/mock.jsonl");
        expect(enabled.enabled).toBe(true);
        const log = await (enabled.queryFn as unknown as () => Promise<LogEntry[]>)();
        expect(Array.isArray(log)).toBe(true);
    });

    it("BACKLOG_LIMIT is a sane positive number", () => {
        expect(BACKLOG_LIMIT).toBeGreaterThan(0);
    });
});
