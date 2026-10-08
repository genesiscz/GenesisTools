import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runOptimize } from "@app/macos/lib/clones/audit";
import { annotateFreeable, type BlockProbe, measureSetFreeable } from "@app/macos/lib/clones/freeable";
import type { DuplicateSet } from "@app/macos/lib/clones/render/types";
import { bunEntryOf, unreferencedEntries } from "@app/macos/lib/clones/store-report";
import { cloneFile } from "@genesiscz/utils/macos/apfs";
import { skip } from "@genesiscz/utils/test/skip";

const SIZE = 256 * 1024;

/** A full private copy. `copyFileSync` is not one: on APFS bun clones. */
function put(path: string, data: Buffer): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
}

function clone(src: string, dst: string): void {
    mkdirSync(dirname(dst), { recursive: true });
    cloneFile(src, dst);
}

function alloc(path: string): number {
    return lstatSync(path).blocks * 512;
}

/** Two byte-identical store entries (X, Y), a worktree file cloned from Y and a
 *  worktree file that is a full private copy. */
function fixture(dir: string) {
    const data = randomBytes(SIZE);
    const store = join(dir, "store");
    const x = join(store, "pkg@2@@@1", "lib.a");
    const y = join(store, "pkg-ios@2@@@1", "lib.a");
    const cloned = join(dir, "wt1", "node_modules", "lib.a");
    const copied = join(dir, "wt2", "node_modules", "lib.a");
    put(x, data);
    put(y, data);
    clone(y, cloned);
    put(copied, data);
    return { store, x, y, cloned, copied };
}

function fileSet(keep: string, members: string[], storeMembers: string[] = []): DuplicateSet {
    return {
        kind: "file",
        what: "lib.a",
        copies: members.length,
        eachBytes: SIZE,
        reclaimable: (members.length - 1) * SIZE,
        members,
        keep,
        ...(storeMembers.length > 0 ? { storeMembers } : {}),
    };
}

describe.skipIf(skip.unlessMac)("measureSetFreeable on real APFS clones", () => {
    it("a replace that is a clone of a keep-only store file frees nothing", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-free-"));
        try {
            const f = fixture(dir);
            const set = fileSet(f.x, [f.x, f.cloned], [f.y]);
            expect(measureSetFreeable({ set, fixedRoots: [f.store], storeRoots: [f.store] })).toEqual({
                proven: 0,
                upTo: 0,
                measured: true,
            });

            const { sets, dropped } = annotateFreeable({ sets: [set], fixedRoots: [f.store], storeRoots: [f.store] });
            expect(sets).toEqual([]);
            expect(dropped).toEqual({ sets: 1, naiveBytes: SIZE });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("counts only the private copy when the store stays keep-only", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-free-"));
        try {
            const f = fixture(dir);
            const set = fileSet(f.x, [f.x, f.cloned, f.copied], [f.y]);
            expect(measureSetFreeable({ set, fixedRoots: [f.store], storeRoots: [f.store] })).toEqual({
                proven: alloc(f.copied),
                upTo: alloc(f.copied),
                measured: true,
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("with the store rewritten, the Y family is wholly in view: proven is the private copy, up-to adds Y", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-free-"));
        try {
            const f = fixture(dir);
            const set = fileSet(f.x, [f.x, f.y, f.cloned, f.copied]);
            const expected = alloc(f.copied) + alloc(f.y);
            expect(measureSetFreeable({ set, fixedRoots: [], storeRoots: [f.store] })).toEqual({
                proven: alloc(f.copied),
                upTo: expected,
                measured: true,
            });

            // Apply agrees: each swap credits what the copy held privately just
            // before it, so Y frees 0 and its last clone frees the shared blocks.
            const report = runOptimize({ roots: [dir], sets: [set], planCacheHit: false });
            expect(report.totals.cloned).toBe(3);
            expect(report.totals.bytesReclaimed).toBe(expected);
            expect(report.freeBytes?.before).toBeGreaterThan(0);
            expect(report.freeBytes?.after).toBeGreaterThan(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("a family of worktree clones whose origin is out of view counts as nothing", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-free-"));
        try {
            const data = randomBytes(SIZE);
            const origin = join(dir, "unseen", "lib.a");
            put(origin, data);
            const keep = join(dir, "wt0", "lib.a");
            put(keep, data);
            const a = join(dir, "wt1", "lib.a");
            const b = join(dir, "wt2", "lib.a");
            clone(origin, a);
            clone(origin, b);
            const set = fileSet(keep, [keep, a, b]);
            expect(measureSetFreeable({ set, fixedRoots: [], storeRoots: [] })).toMatchObject({ proven: 0, upTo: 0 });

            const report = runOptimize({ roots: [dir], sets: [set], planCacheHit: false });
            expect(report.totals.cloned).toBe(2);
            expect(report.totals.bytesReclaimed).toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe.skipIf(skip.unlessMac)("a store file cloned by a tree outside the scan", () => {
    it("frees only the proven bytes: the up-to part stays held by the outside clone", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-free-"));
        try {
            const f = fixture(dir);
            const outside = join(dir, "other-project", "node_modules", "lib.a");
            clone(f.y, outside);
            const set = fileSet(f.x, [f.x, f.y, f.cloned, f.copied]);
            const freeable = measureSetFreeable({ set, fixedRoots: [], storeRoots: [f.store] });

            const report = runOptimize({ roots: [dir], sets: [set], planCacheHit: false });
            expect(report.totals.bytesReclaimed).toBe(freeable.proven);
            expect(freeable.upTo).toBeGreaterThan(freeable.proven);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("annotateFreeable without APFS", () => {
    it("keeps every set unmeasured instead of dropping it as freeing nothing", () => {
        const blind: BlockProbe = { privateBytes: () => null, cloneId: () => null, allocatedBytes: () => null };
        const set = fileSet("/a/lib.a", ["/a/lib.a", "/b/lib.a"]);
        const { sets, dropped } = annotateFreeable({ sets: [set], fixedRoots: [], storeRoots: [], probe: blind });

        expect(sets).toHaveLength(1);
        expect(sets[0].freeable).toBeUndefined();
        expect(dropped).toEqual({ sets: 0, naiveBytes: 0 });
    });
});

describe("unreferencedEntries", () => {
    const root = "/cache";
    const probe = (rows: Record<string, [number, number]>): BlockProbe => ({
        privateBytes: (p) => rows[p]?.[1] ?? null,
        allocatedBytes: (p) => rows[p]?.[0] ?? null,
        cloneId: () => null,
    });

    it("names the bun entry of a file, scoped or not", () => {
        expect(bunEntryOf(root, "/cache/pkg@1@@@1/lib/a.a")).toBe("pkg@1@@@1");
        expect(bunEntryOf(root, "/cache/@scope/pkg@1@@@1/lib/a.a")).toBe("@scope/pkg@1@@@1");
        expect(bunEntryOf(root, "/cache/loose.txt")).toBeNull();
        expect(bunEntryOf(root, "/elsewhere/pkg/a")).toBeNull();
    });

    it("reports only entries whose every file is fully private, largest first", () => {
        const files = {
            "/cache/free@1@@@1/a.a": [4096, 4096],
            "/cache/free@1@@@1/b.a": [8192, 8192],
            "/cache/used@1@@@1/a.a": [4096, 4096],
            "/cache/used@1@@@1/b.a": [8192, 0],
            "/cache/@s/small@1@@@1/a.a": [4096, 4096],
            "/cache/gone@1@@@1/a.a": [4096, 4096],
        } satisfies Record<string, [number, number]>;
        const rows: Record<string, [number, number]> = { ...files };
        delete rows["/cache/gone@1@@@1/a.a"];
        const entries = unreferencedEntries({ root, files: Object.keys(files), probe: probe(rows) });
        expect(entries).toEqual([
            { entry: "free@1@@@1", files: 2, privateBytes: 12288 },
            { entry: "@s/small@1@@@1", files: 1, privateBytes: 4096 },
        ]);
    });
});
