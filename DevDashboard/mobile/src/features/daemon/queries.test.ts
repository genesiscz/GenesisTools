import type { DaemonOverview, LogEntry, RunSummary } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { mockDashboardClient } from "@/api/mock-client";
import {
    DEFAULT_RUNS_LIMIT,
    daemonKeys,
    daemonRunLogQuery,
    daemonRunsQuery,
    daemonStatusQuery,
    RUNS_INTERVAL_MS,
    STATUS_INTERVAL_MS,
} from "@/features/daemon/queries";

/**
 * Proves the daemon data layer flows through the D32 escape-hatch seam WITHOUT a React renderer.
 * Mirrors pulse/queries.test.ts.
 *
 * MOCK behavior, asserted:
 *  - `/api/daemon/status` → returns a real `DaemonOverview` (running).
 *  - `/api/daemon/runs` → now serves a fixture run array (the build-log-tail feature added a mock
 *    branch so its run picker — and this daemon screen's runs list — render a row, not empty).
 *  - `/api/daemon/runs/log` → returns `[]` (no static-log fixture); the factory's `asArray` guard
 *    still keeps it array-shaped. Asserted below.
 */

describe("mock dashboard client — daemon (escape hatch)", () => {
    it("get(/api/daemon/status) returns a believable DaemonOverview", async () => {
        const overview = await mockDashboardClient.get<DaemonOverview>("/api/daemon/status");
        expect(typeof overview.status.running).toBe("boolean");
        expect(Array.isArray(overview.tasks)).toBe(true);
    });

    it("get(/api/daemon/runs) now returns a fixture run array (mock serves the build-log picker)", async () => {
        const raw = await mockDashboardClient.get<unknown>("/api/daemon/runs?limit=25");
        expect(Array.isArray(raw)).toBe(true);
        expect((raw as unknown[]).length).toBeGreaterThan(0);
    });
});

describe("daemon query factories", () => {
    it("daemonStatusQuery builds the status key + interval + a queryFn returning the overview", async () => {
        const opts = daemonStatusQuery(mockDashboardClient);
        expect([...opts.queryKey]).toEqual([...daemonKeys.status]);
        expect(opts.refetchInterval).toBe(STATUS_INTERVAL_MS);
        const data = await (opts.queryFn as unknown as () => Promise<DaemonOverview>)();
        expect(typeof data.status.running).toBe("boolean");
    });

    it("daemonRunsQuery encodes the limit + returns the mock's fixture runs", async () => {
        const opts = daemonRunsQuery(mockDashboardClient);
        expect([...opts.queryKey]).toEqual(["daemon", "runs", DEFAULT_RUNS_LIMIT]);
        expect(opts.refetchInterval).toBe(RUNS_INTERVAL_MS);
        const data = await (opts.queryFn as unknown as () => Promise<RunSummary[]>)();
        expect(Array.isArray(data)).toBe(true);
        expect(data.length).toBeGreaterThan(0);
    });

    it("daemonRunLogQuery is disabled with no logFile, returns [] otherwise (mock gap guarded)", async () => {
        const disabled = daemonRunLogQuery(mockDashboardClient, null);
        expect(disabled.enabled).toBe(false);
        expect([...disabled.queryKey]).toEqual(["daemon", "run-log", ""]);

        const enabled = daemonRunLogQuery(mockDashboardClient, "sync-2026.jsonl");
        expect(enabled.enabled).toBe(true);
        const log = await (enabled.queryFn as unknown as () => Promise<LogEntry[]>)();
        expect(Array.isArray(log)).toBe(true);
        expect(log).toHaveLength(0);
    });
});
