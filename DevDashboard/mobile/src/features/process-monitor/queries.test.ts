import type { ProcessesRes } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { mockDashboardClient } from "@/api/mock-client";
import {
    DEFAULT_LIMIT,
    PROCESSES_INTERVAL_MS,
    processMonitorKeys,
    processesQuery,
} from "@/features/process-monitor/queries";

/**
 * Proves the Process Monitor data layer flows through the typed `client.processes.*` namespace WITHOUT
 * a React renderer. Mirrors containers/queries.test.ts + pulse/queries.test.ts. The load-bearing
 * assertion is that `sort` is encoded INTO the query key (so a sort flip refetches/caches separately)
 * and the server stays authoritative for ordering (the mock returns already-sorted rows).
 */

describe("process-monitor query keys", () => {
    it("encodes sort + limit into the list key", () => {
        expect([...processMonitorKeys.list("rss", 50)]).toEqual(["process-monitor", "list", "rss", 50]);
        expect([...processMonitorKeys.list("name", 50)]).toEqual(["process-monitor", "list", "name", 50]);
    });
});

describe("process-monitor query factory", () => {
    it("builds the sort-keyed list key + interval + a queryFn returning a ProcessesRes (rss desc)", async () => {
        const opts = processesQuery(mockDashboardClient, "rss");
        expect([...opts.queryKey]).toEqual([...processMonitorKeys.list("rss", DEFAULT_LIMIT)]);
        expect(opts.refetchInterval).toBe(PROCESSES_INTERVAL_MS);
        expect(typeof opts.queryFn).toBe("function");

        const data = await (opts.queryFn as unknown as () => Promise<ProcessesRes>)();
        expect(data.sort).toBe("rss");
        expect(data.processes.length).toBeGreaterThan(1);
        expect(data.processes[0].rssBytes).toBeGreaterThanOrEqual(data.processes[1].rssBytes);
    });

    it("name sort returns a ProcessesRes ascending by name", async () => {
        const opts = processesQuery(mockDashboardClient, "name");
        const data = await (opts.queryFn as unknown as () => Promise<ProcessesRes>)();
        expect(data.sort).toBe("name");
        const names = data.processes.map((p) => p.name.toLowerCase());
        const sorted = [...names].sort((a, b) => a.localeCompare(b));
        expect(names).toEqual(sorted);
    });
});

describe("mock dashboard client — processes namespace", () => {
    it("list(rss) puts the largest-RSS process first", async () => {
        const res = await mockDashboardClient.processes.list("rss", DEFAULT_LIMIT);
        expect(res.sort).toBe("rss");
        expect(res.processes[0].name).toBe("node (metro)");
    });

    it("kill returns { ok: true }", async () => {
        expect(await mockDashboardClient.processes.kill(4821)).toEqual({ ok: true });
    });
});
