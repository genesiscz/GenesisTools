import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    cachePlan,
    getCachedPlan,
    membersMatch,
    PLAN_SNAPSHOT_TTL,
    planCacheKey,
    planCacheParams,
    stampRoots,
    stampsMatch,
} from "@app/macos/lib/clones/cache";
import type { DuplicateSet } from "@app/macos/lib/clones/render/types";
import { Storage } from "@genesiscz/utils/storage/storage";

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

describe("plan snapshot member stamps", () => {
    const params = {
        roots: ["/member-stamp-test"],
        minSize: 1,
        include: [],
        exclude: [],
        nodeModules: false,
        targets: [],
        worktreesOf: "",
        keepPartners: [],
    };

    function set(members: string[]): DuplicateSet {
        return {
            kind: "file",
            what: "f",
            copies: members.length,
            eachBytes: 4,
            reclaimable: 4,
            members,
            keep: members[0],
        };
    }

    it("goes stale when a member's content is rewritten in place", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-member-"));
        try {
            const one = join(dir, "one.bin");
            const two = join(dir, "two.bin");
            writeFileSync(one, "aaaa");
            writeFileSync(two, "aaaa");

            await cachePlan(params, [set([one, two])], [{ path: dir, mtimeMs: 1 }]);
            const fresh = await getCachedPlan(params);
            expect(fresh?.memberStamps.length).toBe(2);
            expect(membersMatch(fresh?.memberStamps ?? [])).toBe(true);

            // Same size, same parent-directory mtime: only the member's own
            // mtime moves, which is exactly what the root stamps never saw.
            writeFileSync(one, "bbbb");
            expect(membersMatch(fresh?.memberStamps ?? [])).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("goes stale when a member is gone", () => {
        expect(membersMatch([{ path: "/definitely/not/here/gt-member", size: 1, mtimeNs: "1" }])).toBe(false);
    });

    // The known limit, pinned so nobody reads the stamps as a completeness
    // proof again: they re-stat only what the plan NAMES.
    it("does NOT notice a duplicate created after the plan was written", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-newdup-"));
        try {
            const one = join(dir, "one.bin");
            const two = join(dir, "two.bin");
            writeFileSync(one, "aaaa");
            writeFileSync(two, "aaaa");

            await cachePlan(params, [set([one, two])], [{ path: dir, mtimeMs: 1 }]);
            const fresh = await getCachedPlan(params);

            // A third copy in a nested directory: a new duplicate the plan
            // never listed, so it is in no stamp.
            mkdirSync(join(dir, "nested"), { recursive: true });
            writeFileSync(join(dir, "nested", "three.bin"), "aaaa");

            expect(membersMatch(fresh?.memberStamps ?? [])).toBe(true);
            expect(fresh?.plan[0]?.members).toEqual([one, two]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // The bound on how long that incompleteness can be served.
    it("stops reusing a snapshot older than the 60 s TTL", async () => {
        expect(PLAN_SNAPSHOT_TTL).toBe("60 seconds");

        const uniq = { ...params, roots: [join(tmpdir(), `gt-cl-ttl-${Date.now()}-${Math.random()}`)] };
        await cachePlan(uniq, [], [{ path: uniq.roots[0], mtimeMs: 1 }]);
        expect(await getCachedPlan(uniq)).not.toBeNull();

        // Back-date the file rather than sleeping: expiry is read off its mtime.
        const file = join(new Storage("macos-clones").getCacheDir(), planCacheKey(uniq));
        const past = new Date(Date.now() - 61_000);
        utimesSync(file, past, past);
        expect(await getCachedPlan(uniq)).toBeNull();
    });
});

describe("planCacheKey normalisation", () => {
    it("keys an empty targets list the same as the spelled-out default", () => {
        const base = { roots: ["/k"], minSize: 10 };
        expect(planCacheKey(planCacheParams({ ...base, targets: [] }))).toBe(
            planCacheKey(planCacheParams({ ...base, targets: ["gitignored"] }))
        );
        expect(planCacheKey(planCacheParams({ ...base, targets: ["node_modules"] }))).not.toBe(
            planCacheKey(planCacheParams({ ...base, targets: [] }))
        );
    });
});
