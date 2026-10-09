import { afterEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DedupeFileArgs, DedupeResult } from "@genesiscz/utils/fs/disk-usage";

// The spy stands at the primitive that rewrites a file. It records every pair that reaches it and throws for a
// path under a store the plan did not opt in, so a broken guard fails loudly instead of cloning a store file.
const realDiskUsage = await import("@genesiscz/utils/fs/disk-usage");
const reached: string[] = [];
let forbidden: string[] = [];
const dedupeSpy = mock(({ replace }: DedupeFileArgs): DedupeResult => {
    reached.push(replace);

    if (forbidden.some((root) => replace.startsWith(`${root}/`))) {
        throw new Error(`dedupeFile reached a keep-only store file: ${replace}`);
    }

    return { status: "skipped-same-file", bytesReclaimed: 0 };
});
mock.module("@genesiscz/utils/fs/disk-usage", () => ({ ...realDiskUsage, dedupeFile: dedupeSpy }));
// The guard is platform-independent, but the run refuses before it on a volume without APFS clones (every Linux CI
// runner): say the volume supports them, since the spy above stands in for the only call that would clone.
const realApfs = await import("@genesiscz/utils/macos/apfs");
mock.module("@genesiscz/utils/macos/apfs", () => ({ ...realApfs, isApfsCloneSupported: () => true }));

const { applyReclaimPlan } = await import("@app/macos/lib/clones/plan-runner");
const { reclaimRunPath } = await import("@app/macos/lib/clones/reclaim-run");

type Plan = Parameters<typeof applyReclaimPlan>[0];

function put(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.alloc(4096, 7));
}

/** Two worktree copies and two byte-identical entries of one bun store, all in one set. */
function fixture(dir: string) {
    const store = join(dir, "store");
    const files = {
        keep: join(dir, "wt1", "node_modules", "lib.a"),
        worktree: join(dir, "wt2", "node_modules", "lib.a"),
        storeA: join(store, "pkg@1@@@1", "lib.a"),
        storeB: join(store, "pkg-ios@1@@@1", "lib.a"),
    };

    for (const path of Object.values(files)) {
        put(path);
    }

    return { store, ...files };
}

function planOf(f: ReturnType<typeof fixture>, dir: string, rewriteStores: Plan["selector"]["rewriteStores"]): Plan {
    const members = [f.keep, f.worktree, f.storeA, f.storeB];

    return {
        runId: "guard-run",
        // keepUnfreeable keeps a set that measures at zero: no measurement step can hide what apply does.
        selector: {
            dirs: [dir],
            targets: ["gitignored"],
            exclude: [],
            minReal: 1,
            keepPartners: ["bun"],
            rewriteStores,
            keepUnfreeable: true,
        },
        roots: [dir],
        rootStamps: [],
        skipped: [],
        keepRoots: [{ id: "bun", root: f.store }],
        sets: [
            { kind: "file", what: "lib.a", copies: 4, eachBytes: 4096, reclaimable: 3 * 4096, members, keep: f.keep },
            // A pair inside one store: only an opt-in may rewrite either side.
            {
                kind: "file",
                what: "lib.a",
                copies: 2,
                eachBytes: 4096,
                reclaimable: 4096,
                members: [f.storeA, f.storeB],
                keep: f.storeA,
            },
        ],
        totalReclaimable: 4 * 4096,
        totalFreeable: 0,
        totalFreeableUpTo: 0,
        dropped: { sets: 0, naiveBytes: 0 },
        fromSnapshot: false,
        deniedDirs: 0,
    };
}

describe("applyReclaimPlan store guard", () => {
    afterEach(() => {
        reached.length = 0;
        forbidden = [];

        if (existsSync(reclaimRunPath("guard-run"))) {
            rmSync(reclaimRunPath("guard-run"));
        }
    });

    it("never hands a store file to dedupeFile without --rewrite-stores, and still dedupes the worktree copy", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-guard-"));
        try {
            const f = fixture(dir);
            forbidden = [f.store];
            const result = applyReclaimPlan(planOf(f, dir, []));

            expect(result.status).toBe("ok");
            expect(result.status === "ok" && result.report.totals.errors).toBe(0);
            expect(reached).toEqual([f.worktree]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("with the store opted in, its entries and a same-store pair reach dedupeFile like any other copy", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-guard-"));
        try {
            const f = fixture(dir);
            const result = applyReclaimPlan(planOf(f, dir, ["bun"]));

            expect(result.status).toBe("ok");
            expect(result.status === "ok" && result.report.totals.errors).toBe(0);
            expect(reached).toEqual([f.worktree, f.storeA, f.storeB, f.storeB]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
