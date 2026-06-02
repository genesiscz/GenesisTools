import type { PortsResult } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { mockDashboardClient } from "@/api/mock-client";
import { PORTS_INTERVAL_MS, portKillerKeys, portsQuery } from "@/features/port-killer/queries";

describe("mock dashboard client — ports", () => {
    it("get(/api/ports) returns a well-formed PortsResult", async () => {
        const result = await mockDashboardClient.get<PortsResult>("/api/ports");
        expect(typeof result.lsofAvailable).toBe("boolean");
        expect(Array.isArray(result.ports)).toBe(true);
        expect(result.ports.length).toBeGreaterThan(0);
    });

    it("post(/api/ports/kill) returns { ok }", async () => {
        const result = await mockDashboardClient.post<{ ok: boolean }>("/api/ports/kill", { pid: 1 });
        expect(result.ok).toBe(true);
    });

    it("ports.list() namespace returns a well-formed PortsResult", async () => {
        const result = await mockDashboardClient.ports.list();
        expect(typeof result.lsofAvailable).toBe("boolean");
        expect(result.ports.length).toBeGreaterThan(0);
    });
});

describe("ports query factory", () => {
    it("builds the list key + interval + a queryFn returning a PortsResult", async () => {
        const opts = portsQuery(mockDashboardClient);
        expect([...opts.queryKey]).toEqual([...portKillerKeys.list]);
        expect(opts.refetchInterval).toBe(PORTS_INTERVAL_MS);
        const data = await (opts.queryFn as unknown as () => Promise<PortsResult>)();
        expect(Array.isArray(data.ports)).toBe(true);
    });
});
