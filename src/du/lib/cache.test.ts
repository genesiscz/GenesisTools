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
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanWithCFfi } from "./engine";
import type { ClonesizeResult } from "./types";

const isDarwin = process.platform === "darwin";
const CLONE_MB = 4;
const CLONE_BYTES = CLONE_MB * 1024 * 1024;

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
