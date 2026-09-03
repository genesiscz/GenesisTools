import { describe, expect, it } from "bun:test";
import { cachePlan, getCachedPlan, planCacheKey, stampRoots, stampsMatch } from "@app/macos/lib/clones/cache";
import type { DuplicateSet } from "@app/macos/lib/clones/render/types";

const params = {
    roots: ["/b", "/a"],
    minSize: 10485760,
    include: ["z", "a"],
    exclude: ["x"],
    nodeModules: true,
    targets: [],
    worktreesOf: "",
    keepPartners: [],
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
            targets: [],
            worktreesOf: "",
            keepPartners: [],
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
        await cachePlan(uniq, sets, stampRoots(uniq.roots));
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

describe("planCacheKey selectors", () => {
    const base = {
        roots: ["/a"],
        minSize: 1,
        include: [],
        exclude: [],
        nodeModules: false,
        targets: ["gitignored"],
        worktreesOf: "",
        keepPartners: [],
    };

    it("differs when the targets differ", () => {
        expect(planCacheKey(base)).not.toBe(planCacheKey({ ...base, targets: ["node_modules"] }));
    });

    it("differs when worktreesOf differs", () => {
        expect(planCacheKey(base)).not.toBe(planCacheKey({ ...base, worktreesOf: "app" }));
    });

    it("differs when the keep partners differ", () => {
        expect(planCacheKey(base)).not.toBe(planCacheKey({ ...base, keepPartners: ["bun"] }));
    });

    it("is stable under array order", () => {
        expect(planCacheKey({ ...base, targets: ["a", "b"], keepPartners: ["bun", "npm"] })).toBe(
            planCacheKey({ ...base, targets: ["b", "a"], keepPartners: ["npm", "bun"] })
        );
    });
});

describe("plan cache root stamps", () => {
    const params = {
        roots: ["/stamp-test"],
        minSize: 1,
        include: [],
        exclude: [],
        nodeModules: false,
        targets: [],
        worktreesOf: "",
        keepPartners: [],
    };

    it("round-trips the stamps stored with a plan", async () => {
        const stamps = [{ path: "/stamp-test", mtimeMs: 123456 }];
        await cachePlan(params, [], stamps);
        const cached = await getCachedPlan(params);
        expect(cached?.rootStamps).toEqual(stamps);
    });

    it("stampsMatch is false on empty, on a missing root, on a moved mtime; true on equal", () => {
        const a = [{ path: "/x", mtimeMs: 10 }];
        expect(stampsMatch([], [])).toBe(false);
        expect(stampsMatch(a, [{ path: "/x", mtimeMs: -1 }])).toBe(false);
        expect(stampsMatch(a, [{ path: "/x", mtimeMs: 11 }])).toBe(false);
        expect(stampsMatch(a, [{ path: "/y", mtimeMs: 10 }])).toBe(false);
        expect(stampsMatch(a, [{ path: "/x", mtimeMs: 10 }])).toBe(true);
    });

    it("stampRoots stamps a missing root as -1", () => {
        const got = stampRoots(["/definitely/not/here/gt-stamp"]);
        expect(got).toEqual([{ path: "/definitely/not/here/gt-stamp", mtimeMs: -1 }]);
    });
});
