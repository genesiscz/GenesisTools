import type { NetStatusRes } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { mockDashboardClient } from "@/api/mock-client";
import { NET_STATUS_INTERVAL_MS, netStatusKeys, netStatusQuery } from "@/features/network-status/queries";

describe("network-status mock client", () => {
    it("returns a believable NetStatus in range", async () => {
        const s = await mockDashboardClient.get<NetStatusRes>("/api/net/status");
        expect(["healthy", "degraded", "down"]).toContain(s.quality);
        expect(s.transport).toBe("lan");
        expect(s.latencyMs as number).toBeGreaterThan(0);
        expect(typeof s.ssid).toBe("string");
        expect(typeof s.publicIp).toBe("string");
    });
});

describe("network-status query factory", () => {
    it("builds the key + interval + a queryFn that routes to the client", async () => {
        const opts = netStatusQuery(mockDashboardClient);
        expect([...opts.queryKey]).toEqual([...netStatusKeys.status]);
        expect(opts.refetchInterval).toBe(NET_STATUS_INTERVAL_MS);
        const data = await (opts.queryFn as unknown as () => Promise<NetStatusRes>)();
        expect(["healthy", "degraded", "down"]).toContain(data.quality);
    });
});
