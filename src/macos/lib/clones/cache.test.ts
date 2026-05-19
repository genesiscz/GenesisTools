import { describe, expect, it } from "bun:test";
import { cachePlan, getCachedPlan, planCacheKey } from "@app/macos/lib/clones/cache";
import type { DuplicateSet } from "@app/macos/lib/clones/render/types";

const params = {
    roots: ["/b", "/a"],
    minSize: 10485760,
    include: ["z", "a"],
    exclude: ["x"],
    nodeModules: true,
};

const sets: DuplicateSet[] = [
    {
        kind: "file",
        what: "a",
        copies: 2,
        eachBytes: 100,
        reclaimable: 100,
        members: ["/a", "/b"],
        keep: "/a",
    },
];

describe("planCacheKey", () => {
    it("is stable under root/include/exclude reordering", () => {
        const k1 = planCacheKey(params);
        const k2 = planCacheKey({
            roots: ["/a", "/b"],
            minSize: 10485760,
            include: ["a", "z"],
            exclude: ["x"],
            nodeModules: true,
        });
        expect(k1).toBe(k2);
        expect(k1).toMatch(/^plan-[0-9a-f]{40}\.json$/);
    });

    it("differs when a meaningful param changes", () => {
        expect(planCacheKey(params)).not.toBe(planCacheKey({ ...params, nodeModules: false }));
        expect(planCacheKey(params)).not.toBe(planCacheKey({ ...params, minSize: 1 }));
    });
});

describe("cachePlan / getCachedPlan round-trip", () => {
    it("stores and retrieves the plan with a non-negative age", async () => {
        const uniq = { ...params, roots: [`/tmp/gt-cache-test-${Date.now()}`] };
        await cachePlan(uniq, sets);
        const hit = await getCachedPlan(uniq);
        expect(hit).not.toBeNull();
        expect(hit?.plan).toEqual(sets);
        expect(hit?.ageMs).toBeGreaterThanOrEqual(0);
    });

    it("returns null for an unknown key", async () => {
        const miss = await getCachedPlan({ ...params, roots: [`/never-${Date.now()}-${Math.random()}`] });
        expect(miss).toBeNull();
    });
});
