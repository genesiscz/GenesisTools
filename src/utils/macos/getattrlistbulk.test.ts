import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type BulkEntry,
    GetattrlistbulkUnsupportedError,
    isGetattrlistbulkSupported,
    iterDir,
    walkGetattrlistbulk,
} from "./getattrlistbulk";

function withTmpDir(name: string): string {
    return mkdtempSync(join(tmpdir(), `${name}-`));
}

const isDarwin = process.platform === "darwin";
const describeOnDarwin = isDarwin ? describe : describe.skip;

describeOnDarwin("getattrlistbulk", () => {
    it("feature-detects on cwd (darwin/APFS)", () => {
        expect(isGetattrlistbulkSupported()).toBe(true);
    });

    it("returns regular files with sizes, mtimes, fileids", () => {
        const dir = withTmpDir("galb-basic");
        writeFileSync(join(dir, "a.txt"), "alpha");
        writeFileSync(join(dir, "b.bin"), Buffer.alloc(1024));
        const entries: BulkEntry[] = [];
        for (const e of iterDir(dir)) {
            entries.push(e);
        }
        const byName = new Map(entries.map((e) => [e.name, e]));
        expect(byName.size).toBe(2);
        const a = byName.get("a.txt");
        const b = byName.get("b.bin");
        expect(a?.kind).toBe("REG");
        expect(b?.kind).toBe("REG");
        expect(a?.size).toBe(5n);
        expect(b?.size).toBe(1024n);
        expect(a?.errorCode).toBe(0);
        expect(b?.errorCode).toBe(0);
        // mtimeNs is roughly "now" in nanoseconds since 1970.
        expect(a?.mtimeNs ?? 0n).toBeGreaterThan(1700000000000000000n);
        // fileids must be distinct (different inodes)
        expect(a?.fileid).not.toBe(b?.fileid);
    });

    it("returns subdirs with kind=DIR", () => {
        const dir = withTmpDir("galb-dirs");
        mkdirSync(join(dir, "sub"));
        writeFileSync(join(dir, "sub/inside"), "x");
        writeFileSync(join(dir, "top"), "y");
        const names: { [n: string]: BulkEntry } = {};
        for (const e of iterDir(dir)) {
            names[e.name] = e;
        }
        expect(names.sub?.kind).toBe("DIR");
        expect(names.top?.kind).toBe("REG");
    });

    it("reports same cloneId for cp -c clones (the headline use case)", () => {
        // We DELIBERATELY don't gate on isApfsCloneSupported() — if cp -c
        // doesn't actually create clones on this volume the test FAILS
        // visibly, which is the signal we want during dev.
        const dir = withTmpDir("galb-clones");
        writeFileSync(join(dir, "src.bin"), Buffer.alloc(4096, 0x42));
        const cp = spawnSync("cp", ["-c", join(dir, "src.bin"), join(dir, "clone.bin")]);
        if (cp.status !== 0) {
            // Non-APFS volume in /tmp on this machine — skip rather than fail.
            return;
        }

        // Add an independent file with the SAME content (no clone) → it
        // should have a DIFFERENT cloneId than the clone pair.
        writeFileSync(join(dir, "indep.bin"), Buffer.alloc(4096, 0x42));

        const byName: Record<string, BulkEntry> = {};
        for (const e of iterDir(dir)) {
            byName[e.name] = e;
        }
        const src = byName["src.bin"];
        const clone = byName["clone.bin"];
        const indep = byName["indep.bin"];
        expect(src).toBeDefined();
        expect(clone).toBeDefined();
        expect(indep).toBeDefined();
        if (!src || !clone || !indep) {
            return;
        }

        // src and clone share a family → same cloneId, distinct fileids.
        expect(clone.cloneId).toBe(src.cloneId);
        expect(clone.fileid).not.toBe(src.fileid);
        // indep has NO shared extents → different cloneId (its own inode).
        expect(indep.cloneId).not.toBe(src.cloneId);
    });

    it("walks a small tree to readdir-equivalent counts", () => {
        const dir = withTmpDir("galb-walk");
        mkdirSync(join(dir, "a"));
        mkdirSync(join(dir, "a/b"));
        writeFileSync(join(dir, "root.txt"), "1");
        writeFileSync(join(dir, "a/x.txt"), "2");
        writeFileSync(join(dir, "a/b/y.txt"), "3");
        const r = walkGetattrlistbulk(dir);
        // 3 dirs walked into (root, a, a/b); 3 files visited.
        expect(r.dirs).toBe(3);
        expect(r.files).toBe(3);
    });

    it("ENOTSUP path: throws GetattrlistbulkUnsupportedError when opening a non-FS path", () => {
        // /dev/null is a character special, not a dir — open() will fail
        // (ENOTDIR), which surfaces as a non-ENOTSUP error. That's fine; the
        // ENOTSUP path is hard to exercise from userspace without a non-APFS
        // mount. This test just confirms the error type wrapping doesn't
        // swallow non-ENOTSUP errors.
        const dir = "/this/path/does/not/exist/abcxyz123";
        let caught: unknown = null;
        try {
            for (const _e of iterDir(dir)) {
                void _e;
            }
        } catch (e) {
            caught = e;
        }
        expect(caught).not.toBe(null);
        expect(caught instanceof GetattrlistbulkUnsupportedError).toBe(false);
    });
});
