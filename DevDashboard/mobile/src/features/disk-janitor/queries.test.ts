import type { DiskUsageResult } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { fixtureDashboardClient } from "@/api/fixture-wire";
import { DISK_JANITOR_INTERVAL_MS, diskJanitorKeys, diskUsageQuery } from "@/features/disk-janitor/queries";

describe("mock dashboard client — disk usage (escape hatch)", () => {
    it("get(/api/disk/usage) returns a well-formed, bytes-desc DiskUsageResult", async () => {
        const result = await fixtureDashboardClient.get<DiskUsageResult>("/api/disk/usage");
        expect(typeof result.available).toBe("boolean");
        expect(Array.isArray(result.entries)).toBe(true);
        const bytes = result.entries.map((e) => e.bytes);
        expect(bytes).toEqual([...bytes].sort((a, b) => b - a));
    });
});

describe("disk usage query factory", () => {
    it("builds the usage key + interval + a queryFn returning a DiskUsageResult", async () => {
        const opts = diskUsageQuery(fixtureDashboardClient);
        expect([...opts.queryKey]).toEqual([...diskJanitorKeys.usage]);
        expect(opts.refetchInterval).toBe(DISK_JANITOR_INTERVAL_MS);
        const data = await (opts.queryFn as unknown as () => Promise<DiskUsageResult>)();
        expect(Array.isArray(data.entries)).toBe(true);
    });
});
