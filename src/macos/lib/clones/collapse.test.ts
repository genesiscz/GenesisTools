import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOptimize } from "@app/macos/lib/clones/audit";
import { collapseDuplicates, isUnderAny } from "@app/macos/lib/clones/collapse";
import { getCloneId, getPrivateSize } from "@genesiscz/utils/macos/apfs";
import { skip } from "@genesiscz/utils/test/skip";

function tree(base: string, name: string): void {
    mkdirSync(join(base, name, "lib"), { recursive: true });
    writeFileSync(join(base, name, "index.js"), Buffer.alloc(50_000, 1));
    writeFileSync(join(base, name, "lib", "a.js"), Buffer.alloc(40_000, 2));
}

describe("collapseDuplicates", () => {
    it("rolls identical dirs up to the whole-dir duplicate (not per-file)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-coll-"));
        try {
            mkdirSync(join(dir, "p1"), { recursive: true });
            mkdirSync(join(dir, "p2"), { recursive: true });
            tree(join(dir, "p1"), "dep");
            tree(join(dir, "p2"), "dep");

            const report = await collapseDuplicates({ roots: [dir] });
            expect(report.sets.length).toBe(1);
            const set = report.sets[0];
            expect(set.kind).toBe("dir");
            expect(set.copies).toBe(2);
            expect(set.what).toContain("dep");
            expect(set.members.sort()).toEqual([join(dir, "p1", "dep"), join(dir, "p2", "dep")].sort());
            expect(set.keep).toBe([join(dir, "p1", "dep"), join(dir, "p2", "dep")].sort()[0]);
            expect(set.reclaimable).toBe(set.eachBytes);
            expect(report.totalReclaimable).toBe(set.reclaimable);
            expect(report.hardStop).toEqual([dir]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("HARD STOP: never ascends above a scan root even when parent dirs match", async () => {
        const outer = mkdtempSync(join(tmpdir(), "gt-cl-hs-"));
        try {
            mkdirSync(join(outer, "shared", "r1"), { recursive: true });
            mkdirSync(join(outer, "shared", "r2"), { recursive: true });
            tree(join(outer, "shared", "r1"), "x");
            tree(join(outer, "shared", "r2"), "x");
            const r1 = join(outer, "shared", "r1");
            const r2 = join(outer, "shared", "r2");

            const report = await collapseDuplicates({ roots: [r1, r2] });
            const allPaths = report.sets.flatMap((s) => [s.what, ...s.members]).join("|");
            expect(allPaths).not.toContain(`${join(outer, "shared")}|`);
            for (const s of report.sets) {
                for (const m of s.members) {
                    expect(m.startsWith(r1) || m.startsWith(r2)).toBe(true);
                }
            }
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("count cheap-reject: dirs with different file counts are never whole-dir dupes", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-cr-"));
        try {
            mkdirSync(join(dir, "a"), { recursive: true });
            mkdirSync(join(dir, "b"), { recursive: true });
            writeFileSync(join(dir, "a", "f1"), Buffer.alloc(30_000, 9));
            writeFileSync(join(dir, "b", "f1"), Buffer.alloc(30_000, 9));
            writeFileSync(join(dir, "b", "extra"), Buffer.alloc(10, 1));
            const report = await collapseDuplicates({ roots: [dir] });
            const dirSets = report.sets.filter((s) => s.kind === "dir");
            expect(dirSets.length).toBe(0);
            expect(report.sets.some((s) => s.kind === "file")).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe.skipIf(skip.unlessMac)("collapseDuplicates keep prefers already-cloned extents", () => {
    // Regression test: optimize --apply kept the lex-first private copy and
    // clonefile'd already-shared members onto it, so df did not reclaim.
    it("keeps the clonefile-backed copy when a full copy sorts first", async () => {
        const outer = mkdtempSync(join(tmpdir(), "gt-cl-keep-"));
        try {
            const origin = join(outer, "origin.bin");
            const scan = join(outer, "scan");
            const fullCopy = join(scan, "@copy", "blob");
            const shared = join(scan, "shared", "blob");
            mkdirSync(join(scan, "@copy"), { recursive: true });
            mkdirSync(join(scan, "shared"), { recursive: true });

            const payload = Buffer.alloc(1024 * 1024, 0x5a);
            writeFileSync(origin, payload);
            expect(spawnSync("cp", ["-c", origin, shared]).status).toBe(0);
            writeFileSync(fullCopy, payload);

            expect(fullCopy < shared).toBe(true);
            expect(getCloneId(shared)).not.toBeNull();
            expect(getCloneId(shared)).not.toBe(0n);
            const sharedPrivate = getPrivateSize(shared);
            const copyPrivate = getPrivateSize(fullCopy);
            expect(sharedPrivate).not.toBeNull();
            expect(copyPrivate).not.toBeNull();
            expect(copyPrivate as number).toBeGreaterThan(sharedPrivate as number);

            const report = await collapseDuplicates({ roots: [scan] });
            const fileSets = report.sets.filter((s) => s.kind === "file");
            expect(fileSets.length).toBe(1);
            expect(fileSets[0].keep).toBe(shared);
            expect(fileSets[0].members.sort()).toEqual([fullCopy, shared].sort());
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("apply clonefiles the private copy onto the shared keep", async () => {
        const outer = mkdtempSync(join(tmpdir(), "gt-cl-apply-keep-"));
        try {
            const origin = join(outer, "origin.bin");
            const scan = join(outer, "scan");
            const fullCopy = join(scan, "@copy", "blob");
            const shared = join(scan, "shared", "blob");
            mkdirSync(join(scan, "@copy"), { recursive: true });
            mkdirSync(join(scan, "shared"), { recursive: true });

            const payload = Buffer.alloc(1024 * 1024, 0x5a);
            writeFileSync(origin, payload);
            expect(spawnSync("cp", ["-c", origin, shared]).status).toBe(0);
            writeFileSync(fullCopy, payload);
            const copyPrivateBefore = getPrivateSize(fullCopy) as number;
            expect(copyPrivateBefore).toBeGreaterThan(512 * 1024);

            const report = await collapseDuplicates({ roots: [scan] });
            const applied = runOptimize({ roots: [scan], sets: report.sets, planCacheHit: false });
            expect(applied.totals.errors).toBe(0);
            expect(applied.totals.cloned).toBe(1);
            expect(applied.totals.bytesReclaimed).toBeGreaterThan(0);
            expect(getCloneId(fullCopy)).toBe(getCloneId(shared));
            expect(getPrivateSize(fullCopy) as number).toBeLessThan(256 * 1024);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    // Regression test: @shopify/react-native-skia/libs vs react-native-skia-apple-*
    // collapse to whole-dir sets. Lex keep picks the private @shopify copy.
    it("keeps the clonefile-backed dir when a full-copy dir sorts first", async () => {
        const outer = mkdtempSync(join(tmpdir(), "gt-cl-dirkeep-"));
        try {
            const scan = join(outer, "scan");
            const fullDir = join(scan, "@copy", "dep");
            const sharedDir = join(scan, "shared", "dep");
            mkdirSync(join(fullDir, "lib"), { recursive: true });
            mkdirSync(join(sharedDir, "lib"), { recursive: true });

            const payloadA = Buffer.alloc(50_000, 1);
            const payloadB = Buffer.alloc(40_000, 2);
            const originA = join(outer, "origin-a.bin");
            const originB = join(outer, "origin-b.bin");
            writeFileSync(originA, payloadA);
            writeFileSync(originB, payloadB);
            expect(spawnSync("cp", ["-c", originA, join(sharedDir, "index.js")]).status).toBe(0);
            expect(spawnSync("cp", ["-c", originB, join(sharedDir, "lib", "a.js")]).status).toBe(0);
            writeFileSync(join(fullDir, "index.js"), payloadA);
            writeFileSync(join(fullDir, "lib", "a.js"), payloadB);

            expect(fullDir < sharedDir).toBe(true);
            expect(getCloneId(join(sharedDir, "index.js"))).not.toBe(0n);
            expect(getPrivateSize(join(fullDir, "index.js")) as number).toBeGreaterThan(
                getPrivateSize(join(sharedDir, "index.js")) as number
            );

            const report = await collapseDuplicates({ roots: [scan] });
            const dirSets = report.sets.filter((s) => s.kind === "dir");
            expect(dirSets.length).toBe(1);
            expect(dirSets[0].keep).toBe(sharedDir);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });
});

describe("collapseDuplicates across roots", () => {
    it("matches identical trees that live in two different roots", async () => {
        const outer = mkdtempSync(join(tmpdir(), "gt-cl-xroot-"));
        try {
            const r1 = join(outer, "r1", "node_modules");
            const r2 = join(outer, "r2", "node_modules");
            mkdirSync(r1, { recursive: true });
            mkdirSync(r2, { recursive: true });
            tree(r1, "dep");
            tree(r2, "dep");

            const report = await collapseDuplicates({ roots: [r1, r2] });
            expect(report.sets.length).toBe(1);
            expect(report.sets[0].copies).toBe(2);
            expect(report.sets[0].members.sort()).toEqual([join(r1, "dep"), join(r2, "dep")].sort());
            expect(report.totalReclaimable).toBe(report.sets[0].eachBytes);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });
});

describe("collapseDuplicates keep-only roots", () => {
    it("a member inside a keep-only root always wins keep", async () => {
        const outer = mkdtempSync(join(tmpdir(), "gt-cl-keeponly-"));
        try {
            const scan = join(outer, "scan");
            const store = join(outer, "store");
            mkdirSync(scan, { recursive: true });
            mkdirSync(store, { recursive: true });
            const payload = Buffer.alloc(48_000, 0x33);
            writeFileSync(join(scan, "lib.a"), payload);
            writeFileSync(join(store, "lib.a"), payload);

            const report = await collapseDuplicates({
                roots: [scan],
                keepOnlyRoots: [store],
                partnerFor: () => [join(store, "lib.a")],
            });
            expect(report.sets.length).toBe(1);
            expect(report.sets[0].keep).toBe(join(store, "lib.a"));
            expect(report.sets[0].members.sort()).toEqual([join(scan, "lib.a"), join(store, "lib.a")].sort());
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("drops keep-only members that are not the keep so reclaim counts real targets", async () => {
        const outer = mkdtempSync(join(tmpdir(), "gt-cl-keeponly2-"));
        try {
            const scan = join(outer, "scan");
            const store = join(outer, "store");
            mkdirSync(scan, { recursive: true });
            mkdirSync(join(store, "a"), { recursive: true });
            mkdirSync(join(store, "b"), { recursive: true });
            const payload = Buffer.alloc(48_000, 0x44);
            writeFileSync(join(scan, "lib.a"), payload);
            writeFileSync(join(store, "a", "lib.a"), payload);
            writeFileSync(join(store, "b", "lib.a"), payload);

            const report = await collapseDuplicates({
                roots: [scan],
                keepOnlyRoots: [store],
                partnerFor: () => [join(store, "a", "lib.a"), join(store, "b", "lib.a")],
            });
            expect(report.sets.length).toBe(1);
            expect(report.sets[0].copies).toBe(2);
            expect(report.sets[0].reclaimable).toBe(report.sets[0].eachBytes);
            expect(report.sets[0].members.filter((m) => m.startsWith(store)).length).toBe(1);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });
});

describe("isUnderAny", () => {
    it("matches the root itself and its descendants, not a sibling with the same prefix", () => {
        expect(isUnderAny("/a/b", ["/a/b"])).toBe(true);
        expect(isUnderAny("/a/b/c", ["/a/b"])).toBe(true);
        expect(isUnderAny("/a/bb/c", ["/a/b"])).toBe(false);
        expect(isUnderAny("/x", ["/a/b"])).toBe(false);
        expect(isUnderAny("/a/b", [])).toBe(false);
    });
});

describe.skipIf(process.platform !== "darwin")("collapseDuplicates native walk", () => {
    it("finds cross-root duplicates at the reclaim floor through the clonesize lister", async () => {
        const outer = mkdtempSync(join(tmpdir(), "gt-cl-native-"));
        try {
            const r1 = join(outer, "r1", "node_modules");
            const r2 = join(outer, "r2", "node_modules");
            mkdirSync(join(r1, "skia"), { recursive: true });
            mkdirSync(join(r2, "skia"), { recursive: true });
            const payload = Buffer.alloc(3 * (1 << 20), 7);
            writeFileSync(join(r1, "skia", "lib.a"), payload);
            writeFileSync(join(r2, "skia", "lib.a"), payload);
            writeFileSync(join(r1, "skia", "tiny.txt"), Buffer.alloc(10, 1));

            const report = await collapseDuplicates({ roots: [r1, r2], minSize: 1 << 20, pruneNames: [".git"] });
            expect(report.sets.length).toBe(1);
            expect(report.sets[0]?.members.sort()).toEqual(
                [join(r1, "skia", "lib.a"), join(r2, "skia", "lib.a")].sort()
            );
            // the native pass counts every regular file it saw, including the one below the floor
            expect(report.stats?.walkedFiles).toBe(3);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });
});
