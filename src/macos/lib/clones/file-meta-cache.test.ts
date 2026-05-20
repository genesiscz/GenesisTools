import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMetaCache } from "./file-meta-cache";

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
});
