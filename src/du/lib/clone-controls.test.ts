import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
    closeSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { cloneOrCopy } from "@genesiscz/utils/fs/clone";
import { scanWithBun } from "./bun-scan";
import { BLK, type CloneFixture, makeCloneFixture } from "./clone-fixture";
import { scanPartners, scanWithC, scanWithCFfi } from "./engine";
import type { ClonesizeResult } from "./types";

const describeOnDarwin = process.platform === "darwin" ? describe : describe.skip;

// Shared-bytes contract, pinned on trees whose truth is known by construction:
//   A  no clones      → shared MUST be 0, whatever the tail slack is
//   B  N real clones  → shared MUST be exactly N × base
//   C  worktrees      → both engines agree, and the private rewrites stay private
// The bug this guards: `shared = naive − mapped` counted every file's block
// slack as CoW sharing (32.9% "shared" on a tree with no clones at all).
describeOnDarwin("clonesize controls: shared is sharing, not slack", () => {
    let root: string;
    let fx: CloneFixture;
    const results: Record<string, Record<string, ClonesizeResult>> = {};

    beforeAll(async () => {
        root = mkdtempSync(join(tmpdir(), "gt-clone-controls-"));
        fx = makeCloneFixture(root);
        for (const [name, dir] of [
            ["a", fx.noClones.dir],
            ["b", fx.realClones.dir],
            ["c", fx.worktrees.dir],
        ] as const) {
            results[name] = {
                cffi: scanWithCFfi({ path: dir, threads: 2 }),
                bun: await scanWithBun({ path: dir, threads: 2 }),
            };
        }
    });

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    for (const engine of ["cffi", "bun"] as const) {
        describe(engine, () => {
            it("A: a tree with no clones reports zero shared bytes and non-zero slack", () => {
                const r = results.a![engine]!;
                expect(r.files_scanned).toBe(fx.noClones.files);
                expect(r.shared_bytes).toBe(0);
                expect(r.shared_pct).toBe(0);
                expect(r.unique_allocated_bytes).toBe(r.naive_bytes);
                // odd sizes ⇒ mapped < allocated; this is the slack the old formula mislabeled
                expect(r.unique_bytes).toBeLessThan(r.naive_bytes);
                expect(r.unique_bytes).toBe(fx.noClones.logicalBytes);
            });

            it("B: N real clones share exactly N × base", () => {
                const r = results.b![engine]!;
                const { baseBytes, clones } = fx.realClones;
                expect(r.naive_bytes).toBe(baseBytes * (clones + 1));
                expect(r.unique_bytes).toBe(baseBytes);
                expect(r.unique_allocated_bytes).toBe(baseBytes);
                expect(r.shared_bytes).toBe(baseBytes * clones);
            });

            it("C: cloned worktrees share everything except the rewritten file per copy", () => {
                const r = results.c![engine]!;
                const { copies, filesPerTree, fileBytes } = fx.worktrees;
                const trees = copies + 1;
                expect(r.naive_bytes).toBe(trees * filesPerTree * fileBytes);
                // base tree + one private pkg0 per copy
                expect(r.unique_allocated_bytes).toBe(filesPerTree * fileBytes + copies * fileBytes);
                expect(r.shared_bytes).toBe(r.naive_bytes - r.unique_allocated_bytes!);
            });
        });
    }

    it("both engines agree byte-for-byte on every control", () => {
        for (const name of ["a", "b", "c"]) {
            const c = results[name]!.cffi!;
            const b = results[name]!.bun!;
            expect(b.naive_bytes).toBe(c.naive_bytes);
            expect(b.unique_bytes).toBe(c.unique_bytes);
            expect(b.unique_allocated_bytes).toBe(c.unique_allocated_bytes);
            expect(b.shared_bytes).toBe(c.shared_bytes);
        }
    });
});

// The Bash diff hook keeps a dirty file's before-state as a clone (`cloneOrCopy`, used by
// src/agents/lib/hooks/diff/capture.ts and named.ts). This pins, by the blocks, that the clone shares its
// source's data, so a Bun change cannot quietly turn it into a byte copy, and what a later edit then costs.
describeOnDarwin("cloneOrCopy: a clone holds no blocks of its own until its source changes", () => {
    const BYTES = 256 * BLK;
    const dirs: string[] = [];

    /** A 1 MiB source and its clone in a fresh folder; `mayCopy: false`, so a clone that failed cannot hide. */
    function sourceAndClone(): { dir: string; source: string } {
        const dir = mkdtempSync(join(tmpdir(), "gt-clone-or-copy-"));
        const source = join(dir, "source.bin");

        dirs.push(dir);
        writeFileSync(source, Buffer.alloc(BYTES, 7));
        expect(cloneOrCopy({ source, destination: join(dir, "clone.bin"), mode: 0o600, mayCopy: false })).toBe(
            "cloned"
        );

        return { dir, source };
    }

    afterAll(() => {
        for (const dir of dirs) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("shares every block with its source", () => {
        const { dir } = sourceAndClone();
        const r = scanWithCFfi({ path: dir, threads: 2 });

        expect(r.naive_bytes).toBe(2 * BYTES);
        expect(r.unique_allocated_bytes).toBe(BYTES);
        expect(r.shared_bytes).toBe(BYTES);
    });

    it("pays a few blocks, not the file, when one byte of the source is rewritten in place", () => {
        const { dir, source } = sourceAndClone();
        const fd = openSync(source, "r+");

        writeSync(fd, "!", 0);
        closeSync(fd);

        // Measured 2026-11-01 on APFS: the write un-shares 16 KiB (four 4 KiB blocks) of the 1 MiB.
        const unique = scanWithCFfi({ path: dir, threads: 2 }).unique_allocated_bytes ?? 0;

        expect(unique).toBeGreaterThan(BYTES);
        expect(unique).toBeLessThanOrEqual(BYTES + 16 * BLK);
    });

    it("keeps the old blocks when the source is replaced through a rename, as a copy would have held them", () => {
        const { dir, source } = sourceAndClone();

        writeFileSync(join(dir, "next.bin"), Buffer.alloc(BYTES, 9));
        renameSync(join(dir, "next.bin"), source);

        const r = scanWithCFfi({ path: dir, threads: 2 });

        expect(r.unique_allocated_bytes).toBe(2 * BYTES);
        expect(r.shared_bytes).toBe(0);
    });
});

// The native core kept the first 256 excludes in a fixed array and dropped the rest without an error: a scan given
// 1,032 walked 7 M files instead of 2.57 M. Only the 300th exclude here matches, so any cap below 300 counts victim/.
describeOnDarwin("clonesize excludes: every one is honored, past the 256th", () => {
    const KEEP = 64 * 1024;
    const VICTIM = 128 * 1024;
    let root: string;
    let excludes: string[];

    beforeAll(() => {
        root = realpathSync(mkdtempSync(join(tmpdir(), "gt-clone-excludes-")));
        mkdirSync(join(root, "keep"));
        mkdirSync(join(root, "victim"));
        writeFileSync(join(root, "keep", "a.bin"), Buffer.alloc(KEEP, 0x4b));
        writeFileSync(join(root, "victim", "b.bin"), Buffer.alloc(VICTIM, 0x56));
        const misses = Array.from({ length: 299 }, (_, i) => join(root, `missing-${i}`));
        excludes = [...misses, join(root, "victim")];
    });

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it("the fixture counts victim/ when nothing is excluded", () => {
        const r = scanWithCFfi({ path: root, threads: 2 });
        expect({ files: r.files_scanned, naive: r.naive_bytes }).toEqual({ files: 2, naive: KEEP + VICTIM });
    });

    for (const [name, scan] of [
        ["c-ffi", scanWithCFfi],
        ["c (CLI)", scanWithC],
    ] as const) {
        it(`${name}: the 300th exclude prunes victim/`, () => {
            const r = scan({ path: root, threads: 2, exclude: excludes });
            expect({ files: r.files_scanned, naive: r.naive_bytes }).toEqual({ files: 1, naive: KEEP });
        });
    }
});

describeOnDarwin("transparent compression allocation", () => {
    it("maps the resource fork once for two compressed clones and does not call them sparse", async () => {
        const root = mkdtempSync(join(tmpdir(), "compressed-clones-"));
        const plain = join(root, "plain.txt");
        const pair = join(root, "pair");
        mkdirSync(pair);
        writeFileSync(plain, "record 123456789 abcdefghijklmnopqrstuvwx\n".repeat(300000));
        execFileSync("ditto", ["--noclone", "--hfsCompression", plain, join(pair, "a.txt")], {
            env: env.getProcessEnv(),
        });
        execFileSync("cp", ["-c", "-p", join(pair, "a.txt"), join(pair, "b.txt")], { env: env.getProcessEnv() });
        const allocated = statSync(join(pair, "a.txt")).blocks * 512;
        expect(allocated).toBeGreaterThan(0);

        for (const scan of [scanWithCFfi, scanWithC]) {
            const result = scan({ path: pair, threads: 2, depth: 1 });
            expect(result.unique_allocated_bytes).toBe(allocated);
            expect(result.naive_bytes).toBe(allocated * 2);
            expect(result.unique_bytes).toBeGreaterThan(0);
            expect(result.sparse_files).toBe(0);
            expect(result.nodes?.[0]?.apparent_bytes).toBe(statSync(plain).size * 2);
            expect(result.nodes?.[0]?.sparse_files).toBe(0);
            expect(result.compressed).toEqual({
                files: 2,
                logical_bytes: statSync(plain).size * 2,
                allocated_bytes: allocated * 2,
            });
        }

        const { listCompressionFiles } = await import("./engine");
        const bunResult = await scanWithBun({ path: pair, threads: 2 });
        expect(bunResult.unique_allocated_bytes).toBe(allocated);
        expect(bunResult.compressed?.files).toBe(2);
        const files = await listCompressionFiles(pair);
        expect(files).toHaveLength(2);
        expect(files.every((file) => (file.flags & 0x20) !== 0 && file.nlink === 1)).toBe(true);
        expect(files[0].cloneId).not.toBe("");
        expect(files[0].cloneId).toBe(files[1].cloneId);

        // The partner query maps both phases through the resource fork, so it names the other compressed clone.
        const holder = join(root, "holder");
        mkdirSync(holder);
        execFileSync("cp", ["-c", "-p", join(pair, "a.txt"), join(holder, "c.txt")], { env: env.getProcessEnv() });
        const partners = scanPartners({ target: holder, root, threads: 2 });
        expect(partners.target_shared_bytes).toBeGreaterThan(0);
        expect(partners.partner_files.map((file) => file.path).sort()).toEqual([
            join(pair, "a.txt"),
            join(pair, "b.txt"),
        ]);
    });
});

it("compression estimates skip open, sparse, media, compressed, and unverified clone allocation", async () => {
    const { rankCompressible } = await import("./compression");
    const entry = {
        path: "/fixture/eligible/a.txt",
        size: 2 ** 20,
        allocated: 2 ** 20,
        flags: 0,
        ino: 1,
        mtimeMs: 0,
        nlink: 1,
        cloneId: "",
    };
    const entries = [
        entry,
        { ...entry, path: "/fixture/open.txt" },
        { ...entry, path: "/fixture/sparse.txt", allocated: 800000 },
        { ...entry, path: "/fixture/video.mp4" },
        { ...entry, path: "/fixture/compressed.txt", flags: 0x20 },
        { ...entry, path: "/fixture/shared.txt" },
        { ...entry, path: "/fixture/unknown.txt" },
    ];
    const sampled: string[] = [];
    const result = rankCompressible({
        entries,
        open: new Set(["/fixture/open.txt"]),
        olderThanMs: 1,
        minBytes: 1,
        exts: new Set(["txt"]),
        now: 100,
        privateSize: (path) => (path.includes("shared") ? 0 : path.includes("unknown") ? null : 2 ** 20),
        ratio: (path) => {
            sampled.push(path);
            return 0.25;
        },
    });
    expect(sampled).toEqual([entry.path]);
    expect(result.skippedShared).toBe(2);
    expect(result.folders).toEqual([
        {
            path: "/fixture/eligible",
            files: 1,
            allocated_bytes: 2 ** 20,
            estimated_bytes_after: 2 ** 18,
            estimated_saving_bytes: 3 * 2 ** 18,
            command: "tools compress transparent apply '/fixture/eligible'",
        },
    ]);
});

describeOnDarwin("inline transparent compression", () => {
    it("counts inline compressed files even when APFS reports zero allocated blocks", async () => {
        const root = mkdtempSync(join(tmpdir(), "inline-compression-"));
        const target = join(root, "target");
        mkdirSync(target);
        const plain = join(root, "plain.txt");
        writeFileSync(plain, "a".repeat(128 * 1024));
        const file = join(target, "inline.txt");
        execFileSync("ditto", ["--noclone", "--hfsCompression", plain, file], { env: env.getProcessEnv() });
        const { listCompressionFiles } = await import("./engine");
        const entries = await listCompressionFiles(target);
        expect(entries[0].flags & 0x20).toBe(0x20);
        const result = scanWithCFfi({ path: target });
        expect(result.compressed).toEqual({
            files: 1,
            logical_bytes: 128 * 1024,
            allocated_bytes: statSync(file).blocks * 512,
        });
        expect(result.sparse_files).toBe(0);
        expect(result.unique_allocated_bytes).toBe(statSync(file).blocks * 512);
    });
});
