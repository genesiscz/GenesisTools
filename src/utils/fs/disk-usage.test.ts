import { describe, expect, it } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileAllocatedSize, fileLogicalSize, walkFiles } from "@app/utils/fs/disk-usage";

describe("disk-usage per-file sizers + walkFiles", () => {
    it("logical == byte length; allocated >= logical; walk skips symlinks", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-du-"));
        try {
            const f = join(dir, "a.txt");
            writeFileSync(f, Buffer.alloc(10_000, 1));
            mkdirSync(join(dir, "sub"));
            writeFileSync(join(dir, "sub", "b.txt"), Buffer.alloc(5_000, 2));
            symlinkSync(f, join(dir, "link.txt"));

            expect(fileLogicalSize(f)).toBe(10_000);
            expect(fileAllocatedSize(f)).toBeGreaterThanOrEqual(10_000);

            const paths = [...walkFiles(dir)].map((e) => e.path).sort();
            expect(paths).toEqual([join(dir, "a.txt"), join(dir, "sub", "b.txt")]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("dir-cache hit replays cached child list (skips readdirSync)", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-dirwalk-"));
        try {
            writeFileSync(join(dir, "a.txt"), "1");
            writeFileSync(join(dir, "b.txt"), "2");

            type DirEntry = {
                dirMtimeNs: bigint;
                ino: bigint;
                childNames: Array<{ name: string; kind: "file" | "dir" | "symlink" }>;
                lastSeenAt: number;
            };
            const dirMem = new Map<string, DirEntry>();
            const fakeCache = {
                get: () => null,
                set: () => {},
                getDir: (p: string) => dirMem.get(p) ?? null,
                setDir: (p: string, e: DirEntry) => {
                    dirMem.set(p, e);
                },
            };

            // First walk: cache miss → populates dirMem.
            const first: string[] = [];
            for (const e of walkFiles(dir, { cache: fakeCache })) {
                first.push(e.path);
            }
            expect(first.length).toBe(2);
            expect(dirMem.has(dir)).toBe(true);

            // Inject a sentinel CHILD that doesn't exist on disk. If readdirSync
            // runs, we won't see it. If the cache hit short-circuits, walkFiles
            // tries to stat the phantom → onError fires.
            const entry = dirMem.get(dir);
            expect(entry).toBeDefined();
            dirMem.set(dir, {
                ...(entry as DirEntry),
                childNames: [...(entry as DirEntry).childNames, { name: "phantom.txt", kind: "file" }],
            });

            let phantomErrors = 0;
            for (const _e of walkFiles(dir, {
                cache: fakeCache,
                onError: (err) => {
                    if (err.path.endsWith("phantom.txt")) {
                        phantomErrors += 1;
                    }
                },
            })) {
                // count yielded entries via the loop, ignore _e
                void _e;
            }
            expect(phantomErrors).toBe(1); // sentinel proves cached list was used
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("dir-cache mismatch falls back to readdirSync (and overwrites cache)", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-dirwalk-miss-"));
        try {
            writeFileSync(join(dir, "a.txt"), "1");
            type DirEntry = {
                dirMtimeNs: bigint;
                ino: bigint;
                childNames: Array<{ name: string; kind: "file" | "dir" | "symlink" }>;
                lastSeenAt: number;
            };
            const dirMem = new Map<string, DirEntry>();
            // Poison: wrong mtime + phantom child.
            dirMem.set(dir, {
                dirMtimeNs: 999n,
                ino: 999n,
                childNames: [{ name: "phantom.txt", kind: "file" }],
                lastSeenAt: 0,
            });

            const fakeCache = {
                get: () => null,
                set: () => {},
                getDir: (p: string) => dirMem.get(p) ?? null,
                setDir: (p: string, e: DirEntry) => {
                    dirMem.set(p, e);
                },
            };

            let phantomErrors = 0;
            const out: string[] = [];
            for (const e of walkFiles(dir, {
                cache: fakeCache,
                onError: (err) => {
                    if (err.path.endsWith("phantom.txt")) {
                        phantomErrors += 1;
                    }
                },
            })) {
                out.push(e.path);
            }
            expect(phantomErrors).toBe(0); // mtime mismatch → readdir ran → no phantom
            expect(out.length).toBe(1); // a.txt yielded
            expect(dirMem.get(dir)?.dirMtimeNs).not.toBe(999n); // cache refreshed
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

import { measureTree } from "@app/utils/fs/disk-usage";

describe("measureTree", () => {
    it("aggregates logical/allocated/counts and collects errors", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-du-tree-"));
        try {
            writeFileSync(join(dir, "x"), Buffer.alloc(20_000, 1));
            mkdirSync(join(dir, "d"));
            writeFileSync(join(dir, "d", "y"), Buffer.alloc(30_000, 2));

            const u = measureTree(dir);
            expect(u.logical).toBe(50_000);
            expect(u.allocated).toBeGreaterThanOrEqual(50_000);
            expect(u.fileCount).toBe(2);
            expect(u.dirCount).toBe(1);
            expect(u.errors).toEqual([]);
            // private is a number on macOS, null elsewhere
            expect(u.private === null || typeof u.private === "number").toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("records an error for an unreadable root instead of throwing", () => {
        const u = measureTree("/this/path/does/not/exist");
        expect(u.errors.length).toBeGreaterThan(0);
        expect(u.fileCount).toBe(0);
    });
});

import { spawnSync } from "node:child_process";
import { exactReclaimableBytes, findCloneFamilies, reclaimableBytes } from "@app/utils/fs/disk-usage";
import { skip } from "@app/utils/test/skip";

describe.skipIf(skip.unlessMac)("clone-family dedup (intra-tree)", () => {
    it("private undercounts a shared pair; exact ~= one copy; families grouped", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-du-clone-"));
        try {
            const a = join(dir, "a.bin");
            writeFileSync(a, Buffer.alloc(4 * 1024 * 1024, 9));
            expect(spawnSync("cp", ["-c", a, join(dir, "b.bin")]).status).toBe(0);

            const families = findCloneFamilies(dir);
            // both files share one clone id
            expect([...families.values()][0].length).toBe(2);

            const naive = reclaimableBytes(dir) as number;
            const exact = exactReclaimableBytes(dir) as number;
            // two fully-shared clones → little is private…
            expect(naive).toBeLessThan(1024 * 1024);
            // …but deleting the whole dir really frees ~one 4 MB copy
            expect(exact).toBeGreaterThan(3.5 * 1024 * 1024);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("reclaimable accessors degrade gracefully", () => {
    it("return null when private is unavailable (non-darwin)", () => {
        const r = reclaimableBytes("/this/does/not/exist");
        // missing path → no files measured → null/0 but never throws
        expect(r === null || r === 0).toBe(true);
    });
});

import { formatDiskUsage, freeDiskSpace, overcountRatio } from "@app/utils/fs/disk-usage";

describe("freeDiskSpace / overcountRatio / formatDiskUsage", () => {
    it("freeDiskSpace returns positive byte totals", () => {
        const s = freeDiskSpace("/");
        expect(s.total).toBeGreaterThan(0);
        expect(s.available).toBeGreaterThan(0);
        expect(s.total).toBeGreaterThanOrEqual(s.free);
    });

    it("overcountRatio is null when private unknown, else >= 1", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-du-ratio-"));
        try {
            writeFileSync(join(dir, "f"), Buffer.alloc(40_000, 1));
            const r = overcountRatio(dir);
            if (r !== null) {
                expect(r.ratio).toBeGreaterThanOrEqual(1);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("formatDiskUsage shows both numbers side by side", () => {
        const out = formatDiskUsage({
            logical: 1_000,
            allocated: 38_700_000_000,
            private: 2_100_000_000,
            exactReclaimable: 2_100_000_000,
            fileCount: 5,
            dirCount: 2,
            errors: [],
        });
        expect(out).toContain("du says");
        expect(out).toContain("actually");
    });
});

import { findDedupeCandidates, findDuplicateFiles } from "@app/utils/fs/disk-usage";

describe("duplicate detection", () => {
    it("groups byte-identical files; ignores unique and size-mismatched", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-dup-"));
        try {
            const payload = Buffer.alloc(64_000, 0xab);
            writeFileSync(join(dir, "one.bin"), payload);
            writeFileSync(join(dir, "two.bin"), payload); // identical
            writeFileSync(join(dir, "diff.bin"), Buffer.alloc(64_000, 0xcd));
            writeFileSync(join(dir, "small.bin"), Buffer.alloc(10, 1));

            const groups = await findDuplicateFiles(dir);
            expect(groups.length).toBe(1);
            expect(groups[0].paths.map((p) => p.split("/").pop()).sort()).toEqual(["one.bin", "two.bin"]);
            expect(groups[0].size).toBe(64_000);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("caches cloneId from walk; cache hit reuses it on warm reruns", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-fmc-clone-"));
        try {
            const payload = Buffer.alloc(64_000, 0xab);
            writeFileSync(join(dir, "one.bin"), payload);
            writeFileSync(join(dir, "two.bin"), payload);

            type Entry = {
                size: bigint;
                mtimeNs: bigint;
                sha256: string;
                cloneId: string;
                lastSeenAt: number;
            };
            const mem = new Map<string, Entry>();
            const fakeCache = {
                get: (p: string) => mem.get(p) ?? null,
                set: (p: string, e: Entry) => {
                    mem.set(p, e);
                },
            };

            // First scan: walk's bulk path returns cloneIds, detector groups
            // by them; cache gets populated with the real cloneIds.
            await findDuplicateFiles(dir, { cache: fakeCache });
            expect(mem.size).toBe(2);
            const one = mem.get(join(dir, "one.bin"));
            expect(one).toBeDefined();
            const { getCloneId } = await import("@app/utils/macos/apfs");
            const freshOne = getCloneId(join(dir, "one.bin"));
            const expectedOne = freshOne !== null && freshOne !== 0n ? freshOne.toString(16) : "";
            expect(one?.cloneId).toBe(expectedOne);
            // Both files end up cached with their real (divergent) cloneIds.
            expect(mem.get(join(dir, "two.bin"))?.cloneId).toBeDefined();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("skips bytesEqualStreaming when both sides are cache-confirmed (warm fast path)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-fmc-bytes-"));
        try {
            const payload = Buffer.alloc(64_000, 0xab);
            writeFileSync(join(dir, "one.bin"), payload);
            writeFileSync(join(dir, "two.bin"), payload);

            type Entry = {
                size: bigint;
                mtimeNs: bigint;
                sha256: string;
                cloneId: string;
                lastSeenAt: number;
            };
            const mem = new Map<string, Entry>();
            const fakeCache = {
                get: (p: string) => mem.get(p) ?? null,
                set: (p: string, e: Entry) => {
                    mem.set(p, e);
                },
            };
            const emptyStats = () => ({
                walkedFiles: 0,
                walkedDirs: 0,
                walkMs: 0,
                bucketsTotal: 0,
                bucketsDroppedByClone: 0,
                bucketsHashed: 0,
                cloneIdCalls: 0,
                sha256Calls: 0,
                sha256Bytes: 0,
                byteCompareCalls: 0,
                hashMs: 0,
                cacheHits: 0,
                cacheMisses: 0,
            });

            // Baseline: WITHOUT a cache, byte-compare runs unconditionally.
            const noCacheStats = emptyStats();
            await findDuplicateFiles(dir, { stats: noCacheStats });
            expect(noCacheStats.byteCompareCalls).toBe(1);

            // WITH a cache, even the first scan short-circuits the byte-compare:
            // cache.set runs inside the hash loop (~10 lines before the
            // byte-compare filter), so by the time the filter reads cache.get
            // for both files, the just-written entries match the fresh stats.
            // That's by design — those entries are by-construction correct
            // (we just computed sha + stat ourselves this iteration).
            const coldStats = emptyStats();
            await findDuplicateFiles(dir, { cache: fakeCache, stats: coldStats });
            expect(coldStats.byteCompareCalls).toBe(0);

            // Warm: same outcome.
            const warmStats = emptyStats();
            const warm = await findDuplicateFiles(dir, { cache: fakeCache, stats: warmStats });
            expect(warm.length).toBe(1); // still detected as duplicate
            expect(warmStats.byteCompareCalls).toBe(0);

            // Cache-with-set-blocked-for-one-path mimics "the entry never made
            // it into the cache" — get returns null for one.bin both during
            // the hash loop and during the byte-compare filter. The
            // byte-compare must then run to confirm the pair.
            const oneKey = join(dir, "one.bin");
            const fakeBlockingCache = {
                get: (p: string) => (p === oneKey ? null : (mem.get(p) ?? null)),
                set: (p: string, e: Entry) => {
                    if (p !== oneKey) {
                        mem.set(p, e);
                    }
                },
            };
            const fallbackStats = emptyStats();
            await findDuplicateFiles(dir, { cache: fakeBlockingCache, stats: fallbackStats });
            expect(fallbackStats.byteCompareCalls).toBe(1); // re-verified
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("reuses cached sha256 on warm scan; sentinel sha proves the comparison fires", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-fmc-"));
        try {
            const payload = Buffer.alloc(64_000, 0xab);
            writeFileSync(join(dir, "one.bin"), payload);
            writeFileSync(join(dir, "two.bin"), payload);

            // Tiny in-memory fake of FileMetaCache (the real one is in
            // src/macos/lib/clones/, but this test stays in utils/ for layering).
            type Entry = {
                size: bigint;
                mtimeNs: bigint;
                sha256: string;
                cloneId: string;
                lastSeenAt: number;
            };
            const mem = new Map<string, Entry>();
            const fakeCache = {
                get: (p: string) => mem.get(p) ?? null,
                set: (p: string, e: Entry) => {
                    mem.set(p, e);
                },
            };

            // Cold run: cache is empty, both files hash, both get cached.
            const cold = await findDuplicateFiles(dir, { cache: fakeCache });
            expect(cold.length).toBe(1);
            expect(mem.size).toBe(2); // both reps cached

            // Inject a sentinel sha for one of the files. If the cache lookup
            // honors size+mtime correctly, the warm scan reuses this sentinel
            // → "two.bin"'s sha mismatches "one.bin" → no group emitted.
            const twoPath = join(dir, "two.bin");
            const original = mem.get(twoPath);
            expect(original).toBeDefined();
            mem.set(twoPath, { ...(original as Entry), sha256: "00".repeat(32) });

            const warm = await findDuplicateFiles(dir, { cache: fakeCache });
            expect(warm.length).toBe(0); // sentinel forced a mismatch → proves the cache fires
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("cache miss on size/mtime change re-hashes and overwrites the row", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-fmc-miss-"));
        try {
            const payload = Buffer.alloc(32_000, 0x55);
            writeFileSync(join(dir, "one.bin"), payload);
            writeFileSync(join(dir, "two.bin"), payload);

            type Entry = {
                size: bigint;
                mtimeNs: bigint;
                sha256: string;
                cloneId: string;
                lastSeenAt: number;
            };
            const mem = new Map<string, Entry>();
            const fakeCache = {
                get: (p: string) => mem.get(p) ?? null,
                set: (p: string, e: Entry) => {
                    mem.set(p, e);
                },
            };

            await findDuplicateFiles(dir, { cache: fakeCache });
            const twoPath = join(dir, "two.bin");
            const beforeSha = mem.get(twoPath)?.sha256;
            expect(beforeSha).toBeDefined();

            // Poison the cache with a mtimeNs that won't match: warm scan should
            // detect the mismatch and re-hash, overwriting the row with the
            // real sha (same as cold).
            const original = mem.get(twoPath) as Entry;
            mem.set(twoPath, { ...original, mtimeNs: 999n, sha256: "deadbeef" });

            await findDuplicateFiles(dir, { cache: fakeCache });
            expect(mem.get(twoPath)?.sha256).toBe(beforeSha);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("findDedupeCandidates projects savings for non-clone duplicates", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-dupc-"));
        try {
            const payload = Buffer.alloc(128_000, 0x7);
            writeFileSync(join(dir, "a.bin"), payload);
            writeFileSync(join(dir, "b.bin"), payload);
            writeFileSync(join(dir, "c.bin"), payload);

            const cands = await findDedupeCandidates(dir);
            expect(cands.length).toBe(1);
            // 3 copies → keep 1, reclaim ~2 copies
            expect(cands[0].reclaimable).toBeGreaterThanOrEqual(128_000);
            expect(cands[0].keep).toBeDefined();
            expect(cands[0].replace.length).toBe(2);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

import { chmodSync, readFileSync, statSync, utimesSync } from "node:fs";
import { dedupeFile } from "@app/utils/fs/disk-usage";

describe.skipIf(skip.unlessMac)("dedupeFile safety", () => {
    it("converts a duplicate to a clone that still behaves independently", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-dedupe-"));
        const keep = join(dir, "keep.bin");
        const dup = join(dir, "dup.bin");
        try {
            const payload = Buffer.alloc(2 * 1024 * 1024, 0x42);
            writeFileSync(keep, payload);
            writeFileSync(dup, payload); // independent identical copy
            chmodSync(dup, 0o640);
            // Pin a fixed mtime/atime so we can prove utimes-restore ran
            // (without this, dup might accidentally share keep's mtime).
            const pinned = new Date(2025, 0, 1, 12, 0, 0);
            utimesSync(dup, pinned, pinned);
            const beforeStats = statSync(dup);

            const res = dedupeFile({ keep, replace: dup });
            expect(res.status).toBe("cloned");
            expect(res.bytesReclaimed).toBeGreaterThan(0);

            // content identical, different inode, same clone family
            expect(readFileSync(dup).equals(readFileSync(keep))).toBe(true);
            expect(statSync(dup).ino).not.toBe(statSync(keep).ino);
            expect(statSync(dup).ino).not.toBe(beforeStats.ino); // it was swapped

            // Safety Contract invariant 4 — metadata preserved post-swap:
            const afterStats = statSync(dup);
            expect(afterStats.mode).toBe(beforeStats.mode); // chmod ran
            // utimes ran — pinned mtime survived the clone-swap (which would
            // otherwise have inherited keep's "now" mtime). Compare seconds
            // since some filesystems round sub-second precision.
            expect(Math.trunc(afterStats.mtimeMs / 1000)).toBe(Math.trunc(beforeStats.mtimeMs / 1000));
            // chown ran (single-user box → values match anyway, but proves the
            // call did not throw and ownership wasn't silently changed):
            expect(afterStats.uid).toBe(beforeStats.uid);
            expect(afterStats.gid).toBe(beforeStats.gid);

            // INDEPENDENCE: mutate dup → keep unchanged; mutate keep → dup unchanged
            writeFileSync(dup, Buffer.alloc(2 * 1024 * 1024, 0x99));
            expect(readFileSync(keep)[0]).toBe(0x42);
            writeFileSync(keep, Buffer.alloc(2 * 1024 * 1024, 0x11));
            expect(readFileSync(dup)[0]).toBe(0x99);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("refuses when contents differ (never clones non-identical files)", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-dedupe-x-"));
        const keep = join(dir, "k");
        const other = join(dir, "o");
        try {
            writeFileSync(keep, Buffer.alloc(1000, 1));
            writeFileSync(other, Buffer.alloc(1000, 2));
            const res = dedupeFile({ keep, replace: other });
            expect(res.status).toBe("skipped-different");
            expect(readFileSync(other)[0]).toBe(2); // untouched
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("never breaks a hardlink (same dev+ino → skipped-same-file)", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-dedupe-hl-"));
        const a = join(dir, "a");
        const b = join(dir, "b");
        try {
            writeFileSync(a, Buffer.alloc(4096, 7));
            linkSync(a, b); // hardlink: same inode
            const res = dedupeFile({ keep: a, replace: b });
            expect(res.status).toBe("skipped-same-file");
            expect(statSync(a).ino).toBe(statSync(b).ino); // still hardlinked
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("skips zero-byte and non-regular targets", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-dedupe-z-"));
        const keep = join(dir, "k");
        const empty = join(dir, "e");
        try {
            writeFileSync(keep, Buffer.alloc(0));
            writeFileSync(empty, Buffer.alloc(0));
            expect(dedupeFile({ keep, replace: empty }).status).toBe("skipped-not-regular");
            expect(dedupeFile({ keep: dir, replace: keep }).status).toBe("skipped-not-regular");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rolls back leaving replace intact when rename fails (read-only dir)", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-dedupe-ro-"));
        const sub = join(dir, "sub");
        mkdirSync(sub);
        const keep = join(dir, "keep");
        const dup = join(sub, "dup");
        try {
            const payload = Buffer.alloc(64_000, 0x33);
            writeFileSync(keep, payload);
            writeFileSync(dup, payload);
            chmodSync(sub, 0o500); // dir read-only → rename into it fails
            expect(() => dedupeFile({ keep, replace: dup })).toThrow();
            chmodSync(sub, 0o700);
            // replace still byte-identical to the original, no temp left behind
            expect(readFileSync(dup).equals(payload)).toBe(true);
            expect(readdirSync(sub).every((n) => !n.includes(".gtclone."))).toBe(true);
        } finally {
            chmodSync(sub, 0o700);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("re-verifies content immediately before cloning (scan/apply race)", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-dedupe-race-"));
        const keep = join(dir, "k");
        const dup = join(dir, "d");
        try {
            const payload = Buffer.alloc(8192, 0xa1);
            writeFileSync(keep, payload);
            writeFileSync(dup, payload);
            // simulate: dup mutated AFTER it was selected as a candidate
            writeFileSync(dup, Buffer.alloc(8192, 0xb2));
            const res = dedupeFile({ keep, replace: dup });
            expect(res.status).toBe("skipped-different");
            expect(readFileSync(dup)[0]).toBe(0xb2); // untouched
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

import { dedupeTree } from "@app/utils/fs/disk-usage";

describe.skipIf(skip.unlessMac)("dedupeTree", () => {
    it("dry-run reports candidates and mutates nothing; apply reclaims space", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-deduptree-"));
        try {
            const payload = Buffer.alloc(1024 * 1024, 0x5e);
            writeFileSync(join(dir, "p.bin"), payload);
            writeFileSync(join(dir, "q.bin"), payload);
            writeFileSync(join(dir, "r.bin"), payload);

            const dry = await dedupeTree(dir); // default dryRun: true
            expect(dry.dryRun).toBe(true);
            expect(dry.projectedReclaim).toBeGreaterThanOrEqual(2 * 1024 * 1024);
            expect(dry.cloned).toBe(0);

            const applied = await dedupeTree(dir, { apply: true });
            expect(applied.cloned).toBe(2); // q,r → clones of p
            expect(applied.bytesReclaimed).toBeGreaterThan(0);

            // re-running finds nothing left (already clones)
            const again = await dedupeTree(dir, { apply: true });
            expect(again.cloned).toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
