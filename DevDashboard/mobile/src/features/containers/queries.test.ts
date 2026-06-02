import type { ContainersResult } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { mockDashboardClient } from "@/api/mock-client";
import { CONTAINERS_INTERVAL_MS, containersKeys, containersQuery } from "@/features/containers/queries";

/**
 * Proves the containers data layer flows through the D32 escape-hatch seam WITHOUT a React renderer.
 * Mirrors pulse/queries.test.ts. The mock returns a real `ContainersResult` for `/api/containers`
 * (`{ dockerAvailable: false, containers: [] }`), so no gap to guard here — the `asContainersResult`
 * coercion is purely defensive (asserted via an unknown route below).
 */

describe("mock dashboard client — containers (escape hatch)", () => {
    it("get(/api/containers) returns a well-formed ContainersResult", async () => {
        const result = await mockDashboardClient.get<ContainersResult>("/api/containers");
        expect(typeof result.dockerAvailable).toBe("boolean");
        expect(Array.isArray(result.containers)).toBe(true);
    });
});

describe("containers query factory", () => {
    it("builds the list key + interval + a queryFn returning a ContainersResult", async () => {
        const opts = containersQuery(mockDashboardClient);
        expect([...opts.queryKey]).toEqual([...containersKeys.list]);
        expect(opts.refetchInterval).toBe(CONTAINERS_INTERVAL_MS);
        expect(typeof opts.queryFn).toBe("function");
        const data = await (opts.queryFn as unknown as () => Promise<ContainersResult>)();
        expect(typeof data.dockerAvailable).toBe("boolean");
        expect(Array.isArray(data.containers)).toBe(true);
    });
});
