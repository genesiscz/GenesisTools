import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatCachePruneReport, runCachePrune } from "./cache-prune-daemon";
import { FileMetaCache } from "./file-meta-cache";
import { type DirListing, mapListing, PathPresence } from "./path-presence";

async function withTmpDb<T>(name: string, fn: (dbPath: string, dir: string) => Promise<T> | T): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), `fmc-${name}-`));
    try {
        const dbPath = join(dir, "file-meta.db");
        return await fn(dbPath, dir);
    } finally {
        // Tests close their own FileMetaCache explicitly so resetForTests at
        // the next block is safe. We just clean up the tmpdir.
        rmSync(dir, { recursive: true, force: true });
    }
}

describe("FileMetaCache", () => {
    it("getInstance returns the same instance for the same path", async () => {
        await withTmpDb("singleton", (dbPath) => {
            const a = FileMetaCache.resetForTests(dbPath);
            const b = FileMetaCache.getInstance(dbPath);
            expect(a).toBe(b);
            a.close();
        });
    });

    it("getInstance throws if called with a different path while open", async () => {
        await withTmpDb("singleton-mismatch", (dbPath, dir) => {
            const a = FileMetaCache.resetForTests(dbPath);
            try {
                expect(() => FileMetaCache.getInstance(join(dir, "other.db"))).toThrow(/already open/);
            } finally {
                a.close();
            }
        });
    });

    it("round-trips one entry across open / set / flush / reopen / loadScope", async () => {
        await withTmpDb("roundtrip", async (dbPath, dir) => {
            const c1 = FileMetaCache.resetForTests(dbPath);
            c1.set(`${dir}/a/b.txt`, {
                size: 100n,
                mtimeNs: 1234567890n,
                sha256: "deadbeef",
                cloneId: "abc",
                lastSeenAt: 0,
            });
            await c1.flush(0);
            c1.close();

            const c2 = FileMetaCache.resetForTests(dbPath);
            await c2.loadScope(dir);
            const entry = c2.get(`${dir}/a/b.txt`);
            expect(entry?.sha256).toBe("deadbeef");
            expect(entry?.size).toBe(100n);
            expect(entry?.mtimeNs).toBe(1234567890n);
            expect(entry?.cloneId).toBe("abc");
            c2.close();
        });
    });

    it("preserves bigint mtime_ns past Number.MAX_SAFE_INTEGER (safeIntegers wired)", async () => {
        await withTmpDb("bigint", async (dbPath, dir) => {
            const giantMtime = 1779296558123456789n; // APFS-scale ns, > 2^53
            const c1 = FileMetaCache.resetForTests(dbPath);
            c1.set(`${dir}/big.txt`, {
                size: 1n,
                mtimeNs: giantMtime,
                sha256: "x",
                cloneId: "",
                lastSeenAt: 0,
            });
            await c1.flush(0);
            c1.close();

            const c2 = FileMetaCache.resetForTests(dbPath);
            await c2.loadScope(dir);
            // Without safeIntegers: true this would round-trip lossily and the
            // strict bigint compare would fail — proves the wiring is alive.
            expect(c2.get(`${dir}/big.txt`)?.mtimeNs).toBe(giantMtime);
            c2.close();
        });
    });

    it("pruneScope (TTL-based) only drops rows older than the 30-day TTL", async () => {
        await withTmpDb("prune-ttl", async (dbPath, dir) => {
            const c = FileMetaCache.resetForTests(dbPath);
            const NOW = 1_000_000_000_000; // arbitrary "current" timestamp
            const OLD = NOW - 31 * 86_400_000; // 31 days ago — > TTL
            const FRESH = NOW - 1 * 86_400_000; // 1 day ago — < TTL

            // Two rows in scope-a, one ancient one fresh.
            c.set(`${dir}/scope-a/ancient`, { size: 1n, mtimeNs: 1n, sha256: "x", cloneId: "", lastSeenAt: 0 });
            await c.flush(OLD);
            c.set(`${dir}/scope-a/fresh`, { size: 1n, mtimeNs: 1n, sha256: "y", cloneId: "", lastSeenAt: 0 });
            await c.flush(FRESH);
            // One row in scope-b, also ancient — but pruning scope-a must NOT touch it.
            c.set(`${dir}/scope-b/ancient`, { size: 1n, mtimeNs: 1n, sha256: "z", cloneId: "", lastSeenAt: 0 });
            await c.flush(OLD);

            await c.pruneScope(`${dir}/scope-a`, NOW);
            c.close();

            const c2 = FileMetaCache.resetForTests(dbPath);
            await c2.loadScope(`${dir}/scope-a`);
            await c2.loadScope(`${dir}/scope-b`);
            expect(c2.get(`${dir}/scope-a/ancient`)).toBeNull(); // pruned (TTL exceeded)
            expect(c2.get(`${dir}/scope-a/fresh`)?.sha256).toBe("y"); // kept (within TTL)
            expect(c2.get(`${dir}/scope-b/ancient`)?.sha256).toBe("z"); // kept (other scope)
            c2.close();
        });
    });

    it("pruneScope does NOT delete cache rows after a pure-hit warm rerun (P0 regression)", async () => {
        // The bug fixed here: pruneScope used to take scanStartedAt as cutoff
        // and delete every row not refreshed *this* scan — but cache HITS
        // don't refresh last_seen_at, so warm reruns silently nuked the cache.
        // Reproducing with two synthetic scans 1ms apart proves the fix.
        await withTmpDb("p0-no-suicide", async (dbPath, dir) => {
            const c = FileMetaCache.resetForTests(dbPath);
            const NOW = Date.now();
            // Scan 1: fill cache.
            c.set(`${dir}/a`, { size: 1n, mtimeNs: 1n, sha256: "h1", cloneId: "", lastSeenAt: 0 });
            c.set(`${dir}/b`, { size: 1n, mtimeNs: 1n, sha256: "h2", cloneId: "", lastSeenAt: 0 });
            await c.flush(NOW);
            // Scan 2: pure cache hits — nothing dirty, nothing set. Then prune.
            await c.pruneScope(dir, NOW + 1); // 1ms later; well within TTL
            c.close();

            const c2 = FileMetaCache.resetForTests(dbPath);
            await c2.loadScope(dir);
            expect(c2.get(`${dir}/a`)?.sha256).toBe("h1"); // would have been deleted under the old design
            expect(c2.get(`${dir}/b`)?.sha256).toBe("h2");
            c2.close();
        });
    });

    it("loadScope only loads paths inside the root (prefix-range exact)", async () => {
        await withTmpDb("scope-exact", async (dbPath, dir) => {
            const c = FileMetaCache.resetForTests(dbPath);
            c.set(`${dir}/foo/inside`, { size: 1n, mtimeNs: 1n, sha256: "in", cloneId: "", lastSeenAt: 0 });
            c.set(`${dir}/foobar/sibling`, { size: 1n, mtimeNs: 1n, sha256: "sib", cloneId: "", lastSeenAt: 0 });
            await c.flush(0);
            c.close();

            const c2 = FileMetaCache.resetForTests(dbPath);
            await c2.loadScope(`${dir}/foo`);
            expect(c2.get(`${dir}/foo/inside`)?.sha256).toBe("in");
            expect(c2.get(`${dir}/foobar/sibling`)).toBeNull(); // sibling NOT pulled in by prefix
            c2.close();
        });
    });

    it("flush is a no-op when nothing is dirty", async () => {
        await withTmpDb("clean-flush", async (dbPath, dir) => {
            const c = FileMetaCache.resetForTests(dbPath);
            c.set(`${dir}/a`, { size: 1n, mtimeNs: 1n, sha256: "x", cloneId: "", lastSeenAt: 0 });
            await c.flush(100);
            // Now the dirty set is empty — second flush should be a no-op.
            await c.flush(200);

            c.close();
            const c2 = FileMetaCache.resetForTests(dbPath);
            await c2.loadScope(dir);
            // lastSeenAt from the FIRST flush, not the second (second was no-op).
            expect(c2.get(`${dir}/a`)?.lastSeenAt).toBe(100);
            c2.close();
        });
    });

    it("flush chunks rows past the SQLite parameter limit (>5000 rows)", async () => {
        await withTmpDb("batch", async (dbPath, dir) => {
            const c = FileMetaCache.resetForTests(dbPath);
            // 6,000 rows × 6 cols = 36,000 params > SQLite's 32,766 cap.
            // Without chunking this would throw "too many SQL variables".
            const N = 6_000;
            for (let i = 0; i < N; i++) {
                c.set(`${dir}/f-${i.toString().padStart(5, "0")}`, {
                    size: BigInt(100 + i),
                    mtimeNs: BigInt(1_000_000 + i),
                    sha256: `sha-${i}`,
                    cloneId: "",
                    lastSeenAt: 0,
                });
            }
            await c.flush(123);
            c.close();

            const c2 = FileMetaCache.resetForTests(dbPath);
            await c2.loadScope(dir);
            expect(c2.size()).toBe(N);
            expect(c2.get(`${dir}/f-00000`)?.sha256).toBe("sha-0");
            expect(c2.get(`${dir}/f-05999`)?.sha256).toBe("sha-5999");
            c2.close();
        });
    });

    it("loadScope does not clobber dirty in-memory entries with stale DB rows", async () => {
        await withTmpDb("dirty-guard", async (dbPath, dir) => {
            // Seed DB with stale row.
            const c1 = FileMetaCache.resetForTests(dbPath);
            c1.set(`${dir}/f`, { size: 100n, mtimeNs: 1n, sha256: "stale", cloneId: "", lastSeenAt: 0 });
            await c1.flush(0);
            c1.close();

            // Reopen, write a fresh entry (dirty), then loadScope must NOT
            // replace it with the stale DB row.
            const c2 = FileMetaCache.resetForTests(dbPath);
            c2.set(`${dir}/f`, { size: 200n, mtimeNs: 2n, sha256: "fresh", cloneId: "newclone", lastSeenAt: 0 });
            await c2.loadScope(dir);
            const entry = c2.get(`${dir}/f`);
            expect(entry?.sha256).toBe("fresh");
            expect(entry?.size).toBe(200n);
            c2.close();
        });
    });

    it("upsert via set+flush overwrites existing rows", async () => {
        await withTmpDb("upsert", async (dbPath, dir) => {
            const c1 = FileMetaCache.resetForTests(dbPath);
            c1.set(`${dir}/x`, { size: 100n, mtimeNs: 1n, sha256: "old", cloneId: "", lastSeenAt: 0 });
            await c1.flush(0);
            c1.set(`${dir}/x`, { size: 200n, mtimeNs: 2n, sha256: "new", cloneId: "newclone", lastSeenAt: 0 });
            await c1.flush(0);
            c1.close();

            const c2 = FileMetaCache.resetForTests(dbPath);
            await c2.loadScope(dir);
            const entry = c2.get(`${dir}/x`);
            expect(entry?.size).toBe(200n);
            expect(entry?.sha256).toBe("new");
            expect(entry?.cloneId).toBe("newclone");
            c2.close();
        });
    });

    it("dir-meta round-trips across open/setDir/flushDir/loadDirScope", async () => {
        await withTmpDb("dir-roundtrip", async (dbPath, dir) => {
            const c1 = FileMetaCache.resetForTests(dbPath);
            c1.setDir(`${dir}/sub`, {
                dirMtimeNs: 1234567890n,
                ino: 99n,
                childNames: [
                    { name: "a.txt", kind: "file" },
                    { name: "b", kind: "dir" },
                ],
                lastSeenAt: 0,
            });
            await c1.flushDir(Date.now());
            c1.close();

            const c2 = FileMetaCache.resetForTests(dbPath);
            await c2.loadDirScope(dir);
            const entry = c2.getDir(`${dir}/sub`);
            expect(entry?.dirMtimeNs).toBe(1234567890n);
            expect(entry?.ino).toBe(99n);
            expect(entry?.childNames).toEqual([
                { name: "a.txt", kind: "file" },
                { name: "b", kind: "dir" },
            ]);
            c2.close();
        });
    });

    it("loadDirScope only loads paths inside the root (prefix-range exact)", async () => {
        await withTmpDb("dir-scope-exact", async (dbPath, dir) => {
            const c = FileMetaCache.resetForTests(dbPath);
            c.setDir(`${dir}/foo`, { dirMtimeNs: 1n, ino: 1n, childNames: [], lastSeenAt: 0 });
            c.setDir(`${dir}/foobar`, { dirMtimeNs: 2n, ino: 2n, childNames: [], lastSeenAt: 0 });
            await c.flushDir(Date.now());
            c.close();

            const c2 = FileMetaCache.resetForTests(dbPath);
            await c2.loadDirScope(`${dir}/foo`);
            expect(c2.getDir(`${dir}/foo`)?.dirMtimeNs).toBe(1n);
            expect(c2.getDir(`${dir}/foobar`)).toBeNull();
            c2.close();
        });
    });

    it("pruneDirScope (TTL-based) drops only ancient rows", async () => {
        await withTmpDb("dir-prune-ttl", async (dbPath, dir) => {
            const c = FileMetaCache.resetForTests(dbPath);
            const NOW = 1_000_000_000_000;
            const OLD = NOW - 31 * 86_400_000;
            const FRESH = NOW - 1 * 86_400_000;
            c.setDir(`${dir}/ancient`, { dirMtimeNs: 1n, ino: 1n, childNames: [], lastSeenAt: 0 });
            await c.flushDir(OLD);
            c.setDir(`${dir}/fresh`, { dirMtimeNs: 2n, ino: 2n, childNames: [], lastSeenAt: 0 });
            await c.flushDir(FRESH);

            await c.pruneDirScope(dir, NOW);
            c.close();

            const c2 = FileMetaCache.resetForTests(dbPath);
            await c2.loadDirScope(dir);
            expect(c2.getDir(`${dir}/ancient`)).toBeNull(); // > 30d
            expect(c2.getDir(`${dir}/fresh`)?.ino).toBe(2n);
            c2.close();
        });
    });

    it("flushDir chunks rows past the SQLite parameter limit (>5000 rows)", async () => {
        await withTmpDb("dir-batch", async (dbPath, dir) => {
            const c = FileMetaCache.resetForTests(dbPath);
            const N = 6_000;
            for (let i = 0; i < N; i++) {
                c.setDir(`${dir}/d-${i.toString().padStart(5, "0")}`, {
                    dirMtimeNs: BigInt(1_000_000 + i),
                    ino: BigInt(100_000 + i),
                    childNames: [{ name: "x", kind: "file" }],
                    lastSeenAt: 0,
                });
            }
            await c.flushDir(Date.now());
            c.close();

            const c2 = FileMetaCache.resetForTests(dbPath);
            await c2.loadDirScope(dir);
            expect(c2.getDir(`${dir}/d-00000`)?.ino).toBe(100_000n);
            expect(c2.getDir(`${dir}/d-05999`)?.ino).toBe(105_999n);
            c2.close();
        });
    });
});

describe("FileMetaCache.reconcile", () => {
    it("drops stale rows table-wide and gone paths with one probe per gone subtree, then vacuums", async () => {
        await withTmpDb("reconcile", async (dbPath) => {
            const cache = FileMetaCache.resetForTests(dbPath);
            try {
                const now = Date.UTC(2026, 8, 2);
                const old = now - 45 * 24 * 60 * 60 * 1000;
                const file = (sha: string) => ({
                    size: 10n,
                    mtimeNs: 1n,
                    sha256: sha,
                    prefixHash: "",
                    cloneId: "",
                    lastSeenAt: 0,
                });
                const dir = () => ({ dirMtimeNs: 1n, ino: 1n, childNames: [], lastSeenAt: 0 });

                cache.set("/t/live/old.bin", file("aa"));
                cache.setDir("/t/oldd", dir());
                await cache.flush(old);
                await cache.flushDir(old);

                cache.set("/t/live/a.bin", file("bb"));
                cache.set("/t/gone/b.bin", file("cc"));
                cache.setDir("/t/live", dir());
                cache.setDir("/t/gone", dir());
                cache.setDir("/t/gone/sub", dir());
                await cache.flush(now);
                await cache.flushDir(now);

                const report = await cache.reconcile({
                    nowMs: now,
                    exists: (p) => !p.startsWith("/t/gone"),
                    vacuumAtFraction: 0.5,
                });

                expect(report.rowsBefore).toBe(7);
                expect(report.staleFiles).toBe(1);
                expect(report.staleDirs).toBe(1);
                expect(report.goneFiles).toBe(1);
                expect(report.goneDirs).toBe(2);
                // /, /t, /t/live, /t/live/a.bin, /t/gone: the gone child dir
                // and the file under /t/gone were answered from the memo.
                expect(report.probes).toBe(5);
                expect(report.vacuumed).toBe(true);

                const again = await cache.reconcile({ nowMs: now, exists: () => true, vacuumAtFraction: 0 });
                expect(again.rowsBefore).toBe(2);
                expect(again.staleFiles + again.staleDirs + again.goneFiles + again.goneDirs).toBe(0);
                expect(again.vacuumed).toBe(false);

                await cache.loadScope("/t");
                expect(cache.get("/t/live/a.bin")?.sha256).toBe("bb");
                expect(cache.get("/t/gone/b.bin")).toBeNull();
                expect(cache.get("/t/live/old.bin")).toBeNull();
            } finally {
                cache.close();
            }
        });
    });

    it("on a real tree removes exactly the rows existsSync calls gone, plus stale rows, with one listing per parent", async () => {
        await withTmpDb("reconcile-tree", async (dbPath, dir) => {
            const root = join(dir, "tree");
            mkdirSync(join(root, "live", "sub"), { recursive: true });
            mkdirSync(join(root, "locked"));
            writeFileSync(join(root, "live", "a.bin"), "a");
            writeFileSync(join(root, "live", "sub", "b.bin"), "b");
            writeFileSync(join(root, "locked", "c.bin"), "c");
            symlinkSync(join(root, "live", "a.bin"), join(root, "live", "link.bin"));
            symlinkSync(join(root, "live", "missing.bin"), join(root, "live", "dangling.bin"));
            // Listable no more, still searchable: readdir fails, stat of a known name still works.
            chmodSync(join(root, "locked"), 0o300);
            const cache = FileMetaCache.resetForTests(dbPath);
            try {
                const now = Date.UTC(2026, 9, 12);
                const old = now - 45 * 24 * 60 * 60 * 1000;
                const file = { size: 1n, mtimeNs: 1n, sha256: "s", prefixHash: "", cloneId: "", lastSeenAt: 0 };
                const dirEntry = { dirMtimeNs: 1n, ino: 1n, childNames: [], lastSeenAt: 0 };
                const fileRows = [
                    "live/a.bin",
                    "live/A.BIN",
                    "live/sub/b.bin",
                    "live/link.bin",
                    "live/dangling.bin",
                    "live/gone.bin",
                    "locked/c.bin",
                    "locked/gone.bin",
                    "gone-dir/x/f.bin",
                ].map((p) => join(root, p));
                const dirRows = ["live", "live/sub", "live/gone-sub", "locked", "gone-dir", "gone-dir/x"].map((p) =>
                    join(root, p)
                );
                for (const path of fileRows) {
                    cache.set(path, { ...file });
                }

                for (const path of dirRows) {
                    cache.setDir(path, { ...dirEntry });
                }

                await cache.flush(now);
                await cache.flushDir(now);
                cache.set(join(root, "live", "stale.bin"), { ...file });
                cache.setDir(join(root, "live", "stale-dir"), { ...dirEntry });
                await cache.flush(old);
                await cache.flushDir(old);

                // The oracle: what one existsSync per row says, as the sweep did before it listed directories.
                const goneFiles = fileRows.filter((p) => !existsSync(p));
                const goneDirs = dirRows.filter((p) => !existsSync(p));
                const report = await cache.reconcile({ nowMs: now, vacuumAtFraction: 0 });

                expect(report.staleFiles).toBe(1);
                expect(report.staleDirs).toBe(1);
                expect(report.goneFiles).toBe(goneFiles.length);
                expect(report.goneDirs).toBe(goneDirs.length);
                expect(goneFiles.map((p) => p.slice(root.length + 1)).sort()).toEqual(
                    expect.arrayContaining([
                        "gone-dir/x/f.bin",
                        "live/dangling.bin",
                        "live/gone.bin",
                        "locked/gone.bin",
                    ])
                );
                expect(goneDirs.map((p) => p.slice(root.length + 1)).sort()).toEqual([
                    "gone-dir",
                    "gone-dir/x",
                    "live/gone-sub",
                ]);
                expect(report.fileRows + report.dirRows).toBe(fileRows.length + dirRows.length + 2);
                expect(report.rowsAfter).toBe(fileRows.length + dirRows.length - goneFiles.length - goneDirs.length);
                expect(report.listings).toBeGreaterThan(0);
                // Present plain files and dirs are answered by their parent's listing; only the symlinks, the names a
                // listing misses and the locked folder's rows are probed one by one.
                expect(report.probes).toBeLessThan(fileRows.length + dirRows.length);

                await cache.loadScope(root);
                await cache.loadDirScope(root);
                for (const path of fileRows) {
                    expect(cache.get(path) !== null).toBe(existsSync(path));
                }

                for (const path of dirRows) {
                    expect(cache.getDir(path) !== null).toBe(existsSync(path));
                }

                expect(cache.get(join(root, "live", "stale.bin"))).toBeNull();
                expect(cache.getDir(join(root, "live", "stale-dir"))).toBeNull();
            } finally {
                cache.close();
                chmodSync(join(root, "locked"), 0o755);
            }
        });
    });

    it("answers a parent from its stored children while its stat stamp matches, and lists it once the stamp moves", async () => {
        await withTmpDb("reconcile-stored", async (dbPath, dir) => {
            const root = join(dir, "tree");
            mkdirSync(join(root, "keep"), { recursive: true });
            mkdirSync(join(root, "changed"));
            for (const name of ["keep/a.bin", "keep/b.bin", "changed/c.bin", "changed/d.bin"]) {
                writeFileSync(join(root, name), name);
            }

            const cache = FileMetaCache.resetForTests(dbPath);
            try {
                const now = Date.UTC(2026, 9, 12);
                const stamp = (path: string, children: string[]) => {
                    const st = statSync(path, { bigint: true });
                    return {
                        dirMtimeNs: st.mtimeNs,
                        ino: st.ino,
                        childNames: children.map((name) => ({
                            name,
                            kind: statSync(join(path, name)).isDirectory() ? ("dir" as const) : ("file" as const),
                        })),
                        lastSeenAt: 0,
                    };
                };
                cache.setDir(root, stamp(root, ["changed", "keep"]));
                // A wrong stored list (b.bin missing) must not remove b.bin: a name the stored children lack is probed.
                cache.setDir(join(root, "keep"), stamp(join(root, "keep"), ["a.bin"]));
                cache.setDir(join(root, "changed"), stamp(join(root, "changed"), ["c.bin", "d.bin"]));
                for (const name of ["keep/a.bin", "keep/b.bin", "changed/c.bin", "changed/d.bin"]) {
                    cache.set(join(root, name), { size: 1n, mtimeNs: 1n, sha256: "s", cloneId: "", lastSeenAt: 0 });
                }

                await cache.flush(now);
                await cache.flushDir(now);
                // Removing an entry moves the folder's mtime, so its stored children stop being trusted.
                rmSync(join(root, "changed", "d.bin"));

                const report = await cache.reconcile({ nowMs: now, vacuumAtFraction: 0 });

                expect(report.goneFiles).toBe(1);
                expect(report.goneDirs).toBe(0);
                expect(report.samples.goneFiles).toEqual([join(root, "changed", "d.bin")]);
                // The tree root and keep/ answer from their stored children; changed/ moved and is listed, and so is
                // the temporary folder above the tree, which has no row.
                expect(report.stamps).toBe(3);
                expect(report.storedHits).toBe(2);
                expect(report.listings).toBe(2);
                await cache.loadScope(root);
                expect(cache.get(join(root, "keep", "b.bin"))).not.toBeNull();
                expect(cache.get(join(root, "changed", "c.bin"))).not.toBeNull();
                expect(cache.get(join(root, "changed", "d.bin"))).toBeNull();
            } finally {
                cache.close();
            }
        });
    });

    it("a windowed run checks the next part of the rows, and a full cycle removes what a full sweep does", async () => {
        await withTmpDb("reconcile-window", async (dbPath, dir) => {
            const root = join(dir, "tree");
            const names = ["a", "b", "c", "d", "e", "f"];
            for (const name of names) {
                mkdirSync(join(root, name), { recursive: true });
                writeFileSync(join(root, name, "keep.bin"), name);
            }

            const cache = FileMetaCache.resetForTests(dbPath);
            try {
                const now = Date.UTC(2026, 9, 12);
                const file = { size: 1n, mtimeNs: 1n, sha256: "s", cloneId: "", lastSeenAt: 0 };
                for (const name of names) {
                    cache.set(join(root, name, "keep.bin"), { ...file });
                    cache.set(join(root, name, "gone.bin"), { ...file });
                }

                await cache.flush(now);
                const cursorPath = join(dir, "cursor.json");
                const reports = [];
                for (let run = 0; run < 3; run++) {
                    reports.push(await cache.reconcile({ nowMs: now, vacuumAtFraction: 0, windowRuns: 3, cursorPath }));
                }

                expect(reports.map((r) => r.checked)).toEqual([4, 4, 4]);
                expect(reports.map((r) => r.goneFiles)).toEqual([2, 2, 2]);
                expect(reports[0]?.window).toEqual({ runs: 3, from: "", to: join(root, "b", "keep.bin") });
                expect(reports[1]?.window.from).toBe(join(root, "b", "keep.bin"));
                expect(reports[2]?.window.to).toBeNull();

                await cache.loadScope(root);
                for (const name of names) {
                    expect(cache.get(join(root, name, "keep.bin"))).not.toBeNull();
                    expect(cache.get(join(root, name, "gone.bin"))).toBeNull();
                }

                // The cycle is over, so the next run starts at the top again.
                const next = await cache.reconcile({ nowMs: now, vacuumAtFraction: 0, windowRuns: 3, cursorPath });
                expect(next.window.from).toBe("");
            } finally {
                cache.close();
            }
        });
    });

    it("the prune report names what it checked, what it removed and why, the database size and the phases", async () => {
        await withTmpDb("prune-report", async (dbPath, dir) => {
            const cache = FileMetaCache.resetForTests(dbPath);
            const live = join(dir, "live.bin");
            writeFileSync(live, "x");
            const now = Date.now();
            const file = { size: 1n, mtimeNs: 1n, sha256: "s", cloneId: "", lastSeenAt: 0 };
            cache.set(live, { ...file });
            cache.set(join(dir, "gone.bin"), { ...file });
            await cache.flush(now);
            cache.set(join(dir, "stale.bin"), { ...file });
            await cache.flush(now - 45 * 24 * 60 * 60 * 1000);
            cache.close();

            const result = await runCachePrune(dbPath);
            const report = formatCachePruneReport(result).join("\n");

            expect(report).toContain("rows: 3 (3 files, 0 directories)");
            // Two rows are left after the stale one goes; a seventh of them, rounded up, is one row.
            expect(report).toContain("rows checked: 1, this run's 1/7 of the rows: after the first row up to ");
            expect(report).toContain("rows removed: 2, 1 left");
            expect(report).toContain("stale, not seen by a scan in 30 days: 1 files, 0 directories");
            expect(report).toContain("gone, the path no longer exists: 1 files, 0 directories");
            expect(report).toContain(`    ${join(dir, "gone.bin")}`);
            expect(report).toContain(`    ${join(dir, "stale.bin")}`);
            expect(report).toMatch(/database: .+ before, .+ after/);
            expect(report).toMatch(/vacuum: yes, 2 of 3 rows removed \(66\.67%\), at or over the 10% threshold/);
            expect(report).toMatch(/phases: count .+, sweep .+ \(row reads .+, existence checks .+, deletes .+\)/);
            expect(report).toMatch(/total: /);
        });
    });
});

describe("PathPresence", () => {
    function fakeTree(paths: Record<string, "file" | "dir" | "link">) {
        const listed: string[] = [];
        const probed: string[] = [];
        const listDir = (dir: string): DirListing | null => {
            listed.push(dir);
            if (dir !== "/" && paths[dir] !== "dir") {
                return null;
            }

            const prefix = dir === "/" ? "/" : `${dir}/`;
            const entries = new Map<string, boolean>();
            for (const [path, kind] of Object.entries(paths)) {
                if (path.startsWith(prefix) && !path.slice(prefix.length).includes("/")) {
                    entries.set(path.slice(prefix.length), kind !== "link");
                }
            }

            return mapListing(entries);
        };
        const exists = (path: string): boolean => {
            probed.push(path);
            return path === "/" || paths[path] === "file" || paths[path] === "dir";
        };
        return { listDir, exists, listed, probed };
    }

    it("lists each parent once for sorted paths and probes only what a listing cannot settle", () => {
        const tree = fakeTree({
            "/r": "dir",
            "/r/a": "dir",
            "/r/a/f1": "file",
            "/r/a/f2": "file",
            "/r/a/sub": "dir",
            "/r/a/sub/g": "file",
            "/r/a/link": "link",
            "/r/b": "dir",
        });
        const presence = new PathPresence({ exists: tree.exists, listDir: tree.listDir });

        expect(presence.dirExists("/r/a")).toBe(true);
        expect(presence.fileExists("/r/a/f1")).toBe(true);
        expect(presence.fileExists("/r/a/f2")).toBe(true);
        expect(presence.dirExists("/r/a/sub")).toBe(true);
        expect(presence.fileExists("/r/a/sub/g")).toBe(true);
        expect(presence.fileExists("/r/a/gone")).toBe(false);
        // A symlink is listed, but existsSync follows it: the listing cannot answer, the probe does.
        expect(presence.fileExists("/r/a/link")).toBe(false);
        expect(presence.dirExists("/r/b")).toBe(true);
        expect(presence.dirExists("/r/gone")).toBe(false);
        expect(presence.fileExists("/r/gone/deep/x")).toBe(false);

        // "/r/gone/deep" is never listed: its parent is already known gone.
        expect(tree.listed).toEqual(["/r", "/r/a", "/r/a/sub"]);
        expect(tree.probed).toEqual(["/r/a/gone", "/r/a/link", "/r/gone"]);
        expect(presence.listings).toBe(3);
        expect(presence.probes).toBe(3);
    });

    it("falls back to the probe chain when nothing can be listed, as the old sweep did", () => {
        const tree = fakeTree({ "/t": "dir", "/t/live": "dir", "/t/live/a.bin": "file" });
        const presence = new PathPresence({ exists: tree.exists, listDir: () => null });

        expect(presence.dirExists("/t/gone")).toBe(false);
        expect(presence.fileExists("/t/gone/b.bin")).toBe(false);
        expect(presence.dirExists("/t/live")).toBe(true);
        expect(presence.fileExists("/t/live/a.bin")).toBe(true);
        expect(tree.probed).toEqual(["/", "/t", "/t/gone", "/t/live", "/t/live/a.bin"]);
    });
});
