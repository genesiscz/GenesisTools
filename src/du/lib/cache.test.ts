// Extent-cache correctness. The cache skips open()+fcntl(F_LOG2PHYS_EXT) for any
// file whose (fileid, mtime, dlen, alloc) is unchanged, which is ~60% of a scan's
// cost — so a stale hit would silently report wrong bytes rather than fail. These
// tests pin the hit/miss/invalidate/corrupt paths against ground truth taken with
// the cache read disabled.
//
// Darwin-only: the fixture needs clonefile(2) (`cp -c`) and the engine needs
// getattrlistbulk + F_LOG2PHYS_EXT. CI runs ubuntu, where these are skipped.

import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanWithCFfi } from "./engine";
import type { ClonesizeResult } from "./types";

const isDarwin = process.platform === "darwin";
const CLONE_MB = 4;
const CLONE_BYTES = CLONE_MB * 1024 * 1024;

// CacheHeader layout: magic(8) version(4) reserved(4) fsid(8) nrecs(8) nexts(8).
const HEADER_BYTES = 40;
const NRECS_OFFSET = 24;
const NEXTS_OFFSET = 32;
/** CacheEnt: fileid, mtime_ns, dlen, alloc, ext_off (8 each) + ext_count, last_seen (4 each). */
const CACHE_ENT_BYTES = 48;
/** Mirrors CACHE_MAX_RECS in clonesize.c. */
const CACHE_MAX_RECS = 2_000_000;
const FORGED_RECS = CACHE_MAX_RECS - 1;

const tmpDirs: string[] = [];

function makeTmp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
}

/** One 4 MB file plus two APFS clones of it — 12 MB naive, 4 MB real. */
function makeCloneFixture(): string {
    const fixture = makeTmp("du-cache-fix-");
    const orig = join(fixture, "orig.bin");
    writeFileSync(orig, Buffer.alloc(CLONE_BYTES, "x"));
    execFileSync("cp", ["-c", orig, join(fixture, "clone1.bin")]);
    execFileSync("cp", ["-c", orig, join(fixture, "clone2.bin")]);
    return fixture;
}

function scan(path: string, cacheDir: string, noCache = false): ClonesizeResult {
    return scanWithCFfi({ path, cacheDir, noCache });
}

/** What the scan reports with the cache read disabled — the reference answer. */
function groundTruth(path: string): ClonesizeResult {
    return scanWithCFfi({ path });
}

afterAll(() => {
    for (const dir of tmpDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe.skipIf(!isDarwin)("extent cache", () => {
    it("writes on a cold run and serves every file from the cache on the next one", () => {
        const fixture = makeCloneFixture();
        const cacheDir = makeTmp("du-cache-dir-");

        // --no-cache writes the cache but never reads it: the honest cold run.
        const cold = scan(fixture, cacheDir, true);
        expect(cold.files_scanned).toBe(3);
        expect(cold.files_opened).toBe(3);
        expect(cold.files_cached).toBe(0);
        // Guards the fixture itself: if `cp -c` had fallen back to a full copy,
        // unique would equal naive and every assertion below would be vacuous.
        expect(cold.naive_bytes).toBe(3 * CLONE_BYTES);
        expect(cold.unique_bytes).toBe(CLONE_BYTES);

        const warm = scan(fixture, cacheDir);
        expect(warm.files_opened).toBe(0);
        expect(warm.files_cached).toBe(3);

        // The point of the cache is that skipping the syscalls changes nothing.
        expect(warm.unique_bytes).toBe(cold.unique_bytes);
        expect(warm.naive_bytes).toBe(cold.naive_bytes);
        expect(warm.unique_allocated_bytes).toBe(cold.unique_allocated_bytes);
        expect(warm.shared_bytes).toBe(cold.shared_bytes);
        expect(warm.extents).toBe(cold.extents);
        expect(warm.files_scanned).toBe(cold.files_scanned);
    }, 60_000);

    it("drops a file that was rewritten in place and re-reads the truth", () => {
        const fixture = makeCloneFixture();
        const cacheDir = makeTmp("du-cache-dir-");

        scan(fixture, cacheDir, true);
        expect(scan(fixture, cacheDir).files_cached).toBe(3);

        // Rewriting a clone breaks its block sharing AND bumps its mtime, so its
        // cache entry must not be trusted: real unique bytes go 4 MB -> 8 MB.
        writeFileSync(join(fixture, "clone1.bin"), Buffer.alloc(CLONE_BYTES, "y"));

        const warm = scan(fixture, cacheDir);
        const truth = groundTruth(fixture);

        expect(warm.files_cached).toBe(2);
        expect(warm.unique_bytes).toBe(truth.unique_bytes);
        expect(warm.unique_bytes).toBe(2 * CLONE_BYTES);
        expect(warm.naive_bytes).toBe(truth.naive_bytes);
        expect(warm.unique_allocated_bytes).toBe(truth.unique_allocated_bytes);
    }, 60_000);

    it("ignores a corrupted cache file instead of trusting or crashing on it", () => {
        const fixture = makeCloneFixture();
        const cacheDir = makeTmp("du-cache-dir-");

        scan(fixture, cacheDir, true);
        const files = readdirSync(cacheDir).filter((f) => f.startsWith("extents-"));
        expect(files.length).toBe(1);

        // Garbage fails the magic/version/fsid/size header check in cache_open.
        writeFileSync(join(cacheDir, files[0]!), "GARBAGE".repeat(64));

        const after = scan(fixture, cacheDir);
        const truth = groundTruth(fixture);

        expect(after.files_cached).toBe(0);
        expect(after.files_opened).toBe(3);
        expect(after.unique_bytes).toBe(truth.unique_bytes);
        expect(after.naive_bytes).toBe(truth.naive_bytes);
    }, 60_000);

    it("rejects a record count the file is too small to hold", () => {
        // cache_open bounds each count by DIVIDING the space that is actually there,
        // so an inconsistent or truncated file is dropped. This is a CONSISTENCY
        // check, not a ceiling on the count itself — see the eviction test below for
        // a header that claims just as much and is padded to back it up. For counts
        // large enough to overflow the arithmetic, see the overflow tests after it.
        const fixture = makeCloneFixture();
        const cacheDir = makeTmp("du-cache-dir-");

        scan(fixture, cacheDir, true);
        const cacheFile = join(cacheDir, readdirSync(cacheDir).find((f) => f.startsWith("extents-"))!);

        const buf = readFileSync(cacheFile);
        expect(buf.readBigUInt64LE(NRECS_OFFSET)).toBe(3n);
        buf.writeBigUInt64LE(1_999_999n, NRECS_OFFSET);
        writeFileSync(cacheFile, buf);

        const after = scan(fixture, cacheDir);
        const truth = groundTruth(fixture);

        expect(after.files_cached).toBe(0);
        expect(after.files_opened).toBe(3);
        expect(after.unique_bytes).toBe(truth.unique_bytes);
    }, 60_000);

    it("evicts down to CACHE_MAX_RECS when the merged set overflows", () => {
        // Reaching eviction by writing 2M real files would take minutes. A cache that
        // *claims* 1,999,999 records and is padded to actually hold them passes
        // cache_open's size check, so the merge (1,999,999 carried over + this run's
        // records) crosses CACHE_MAX_RECS and the recency truncation has to fire.
        const fixture = makeCloneFixture();
        const cacheDir = makeTmp("du-cache-dir-");

        scan(fixture, cacheDir, true);
        const cacheFile = join(cacheDir, readdirSync(cacheDir).find((f) => f.startsWith("extents-"))!);

        // Keep the real magic/version/fsid so the file is accepted, then claim 1,999,999
        // zeroed records (fileid 0, last_seen 0) and no extents.
        const header = readFileSync(cacheFile).subarray(0, HEADER_BYTES);
        header.writeBigUInt64LE(BigInt(FORGED_RECS), NRECS_OFFSET);
        header.writeBigUInt64LE(0n, NEXTS_OFFSET);
        writeFileSync(cacheFile, Buffer.concat([header, Buffer.alloc(FORGED_RECS * CACHE_ENT_BYTES)]));

        const after = scan(fixture, cacheDir);

        // The forged records match no real file, so everything is read from disk and
        // the totals stay correct through the whole exercise.
        expect(after.files_cached).toBe(0);
        expect(after.files_opened).toBe(3);
        expect(after.unique_bytes).toBe(CLONE_BYTES);

        // 1,999,999 carried over + 3 fresh = 2,000,002, truncated back to the cap.
        expect(readFileSync(cacheFile).readBigUInt64LE(NRECS_OFFSET)).toBe(BigInt(CACHE_MAX_RECS));
    }, 60_000);

    // Counts big enough to wrap the size arithmetic. Before cache_open validated by
    // division, `nrecs * sizeof(CacheEnt)` was computed first and wrapped a 64-bit
    // size_t, so these headers passed the check and cache_lookup binary-searched far
    // past the end of the mapping — `nrecs = 2^60` segfaulted the scan (exit 139).
    // Each case must now be rejected, leaving the scan to read the filesystem.
    const OVERFLOW_HEADERS: [name: string, nrecs: bigint, nexts: bigint][] = [
        // 48 * 2^60 == 3 * 2^64, i.e. the record term wraps to EXACTLY zero.
        ["a record count wrapping to zero", 1n << 60n, 0n],
        ["a record count at UINT64_MAX", (1n << 64n) - 1n, 0n],
        ["an extent count at UINT64_MAX", 3n, (1n << 64n) - 1n],
        ["both counts oversized", 1n << 60n, (1n << 64n) - 1n],
    ];

    for (const [name, nrecs, nexts] of OVERFLOW_HEADERS) {
        it(`rejects ${name} instead of reading past the mapping`, () => {
            const fixture = makeCloneFixture();
            const cacheDir = makeTmp("du-cache-dir-");

            scan(fixture, cacheDir, true);
            const cacheFile = join(cacheDir, readdirSync(cacheDir).find((f) => f.startsWith("extents-"))!);

            const buf = readFileSync(cacheFile);
            buf.writeBigUInt64LE(nrecs, NRECS_OFFSET);
            buf.writeBigUInt64LE(nexts, NEXTS_OFFSET);
            writeFileSync(cacheFile, buf);

            // Reaching this line at all is most of the assertion: the pre-fix binary
            // died with SIGSEGV here rather than returning a result.
            const after = scan(fixture, cacheDir);

            expect(after.files_cached).toBe(0);
            expect(after.files_opened).toBe(3);
            expect(after.unique_bytes).toBe(CLONE_BYTES);
        }, 60_000);
    }

    it("keeps records for files outside the scanned subtree when it rewrites", () => {
        // The cache is per VOLUME, so a scan of one subtree must merge its records
        // into the existing file rather than truncating it to that subtree —
        // otherwise alternating scan roots would never stay warm.
        const fixture = makeCloneFixture();
        const cacheDir = makeTmp("du-cache-dir-");
        const sub = join(fixture, "sub");
        mkdirSync(sub);
        execFileSync("cp", ["-c", join(fixture, "orig.bin"), join(sub, "deep.bin")]);

        scan(fixture, cacheDir, true);

        // A fully-warm scan skips the rewrite entirely (clonesize.c: `opened == 0`),
        // which would make this test vacuous. Add an unseen file so the subtree scan
        // takes a miss, opens it, and genuinely rewrites the cache.
        execFileSync("cp", ["-c", join(fixture, "orig.bin"), join(sub, "fresh.bin")]);

        const subScan = scan(sub, cacheDir);
        expect(subScan.files_opened).toBeGreaterThan(0);

        // The parent's three records were NOT part of that scan; they must survive.
        const warmParent = scan(fixture, cacheDir);
        expect(warmParent.files_scanned).toBe(5);
        expect(warmParent.files_opened).toBe(0);
        expect(warmParent.files_cached).toBe(5);
    }, 60_000);
});
