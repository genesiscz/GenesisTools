import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanWithBun } from "./bun-scan";
import { type CloneFixture, makeCloneFixture } from "./clone-fixture";
import { scanWithC, scanWithCFfi } from "./engine";
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
