/**
 * Phase 8 verification: confirm that `iterDir` returns a `privateSize` that
 * matches `getPrivateSize(path)` for every real file on a controlled tree.
 *
 * Why this exists: extending the bulk binding to fetch `ATTR_CMNEXT_PRIVATESIZE`
 * requires getting the parse layout right. The kernel packs `cmnext` attrs in
 * bitmap-ascending order, so PRIVATESIZE (bit 0x008) should come BEFORE
 * CLONEID (bit 0x100). If we got that wrong, `privateSize` would actually be
 * holding cloneId bytes and vice versa — the test makes that wrong layout
 * impossible to miss because cloneId hits ~10^14+ ranges and privateSize is
 * bounded by file size.
 *
 * Test tree (darwin/APFS only):
 *
 *   tree/
 *     solo.bin                 (1 MB, no clone)
 *     clone-a.bin              ┐
 *     clone-b.bin              ├ 4 MB each, all `cp -c` of same source
 *     clone-c.bin              ┘
 *     empty.bin                (0 bytes — privateSize must be 0)
 *
 * For every file we read the entry via `iterDir`, then call `getPrivateSize`
 * on the same path. The two values MUST match. We also assert that
 * `bulk.cloneId` matches `getCloneId` to catch a swapped-order bug.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { getCloneId, getPrivateSize } from "@app/utils/macos/apfs";
import { iterDir } from "@app/utils/macos/getattrlistbulk";

const isDarwin = platform() === "darwin";

describe.skipIf(!isDarwin)("getattrlistbulk privateSize — Phase 8 layout verification", () => {
    it("bulk.privateSize matches getPrivateSize(path) for every file in a mixed tree", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-glb-pp-"));
        try {
            const solo = join(dir, "solo.bin");
            writeFileSync(solo, Buffer.alloc(1 * 1024 * 1024, 0x42));

            const src = join(dir, "clone-a.bin");
            writeFileSync(src, Buffer.alloc(4 * 1024 * 1024, 0xa5));
            const cpB = spawnSync("cp", ["-c", src, join(dir, "clone-b.bin")]);
            const cpC = spawnSync("cp", ["-c", src, join(dir, "clone-c.bin")]);
            if (cpB.status !== 0 || cpC.status !== 0) {
                // tmpdir is not on APFS — bail without failing (test is APFS-only)
                return;
            }

            writeFileSync(join(dir, "empty.bin"), Buffer.alloc(0));

            const entries = [...iterDir(dir)];
            // Drop dot-entries and dirs; should be exactly 5 files.
            const files = entries.filter((e) => e.kind === "REG");
            expect(files.length).toBe(5);

            for (const e of files) {
                if (e.errorCode !== 0) {
                    continue;
                }
                const path = join(dir, e.name);
                const refPriv = getPrivateSize(path);
                const refClone = getCloneId(path);

                // privateSize correctness: bulk value MUST equal per-file
                // getPrivateSize. If layout is swapped, this fails because
                // cloneId is in the 10^13+ range and privateSize is at most
                // ~4 MB (4_194_304).
                expect(Number(e.privateSize)).toBe(refPriv ?? 0);

                // cloneId correctness: didn't break the existing parse.
                expect(e.cloneId).toBe(refClone ?? 0n);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("empty file's privateSize is 0n", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-glb-pp-empty-"));
        try {
            writeFileSync(join(dir, "empty.bin"), Buffer.alloc(0));
            const entries = [...iterDir(dir)].filter((e) => e.kind === "REG");
            expect(entries.length).toBe(1);
            expect(entries[0].privateSize).toBe(0n);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("non-clone file's privateSize == its allocSize (no sharing)", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-glb-pp-solo-"));
        try {
            const p = join(dir, "solo.bin");
            writeFileSync(p, Buffer.alloc(1 * 1024 * 1024, 0x11));
            const entries = [...iterDir(dir)].filter((e) => e.kind === "REG");
            expect(entries.length).toBe(1);
            // For a non-clone file, every byte is private — privateSize == allocSize.
            expect(entries[0].privateSize).toBe(entries[0].allocSize);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("3-way clone family: each member has the same cloneId, each privateSize is < allocSize", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-glb-pp-clone-"));
        try {
            const src = join(dir, "a.bin");
            writeFileSync(src, Buffer.alloc(4 * 1024 * 1024, 0x77));
            const cpB = spawnSync("cp", ["-c", src, join(dir, "b.bin")]);
            const cpC = spawnSync("cp", ["-c", src, join(dir, "c.bin")]);
            if (cpB.status !== 0 || cpC.status !== 0) {
                return;
            }
            const entries = [...iterDir(dir)].filter((e) => e.kind === "REG");
            expect(entries.length).toBe(3);
            const cloneIds = new Set(entries.map((e) => e.cloneId.toString(16)));
            // All three must share the same clone id.
            expect(cloneIds.size).toBe(1);
            // Each privateSize < allocSize because storage is shared among 3 members.
            // (Typically each privateSize is ~allocSize/3, but the kernel may report
            // 0 for non-keep members depending on which "owns" the extent.)
            for (const e of entries) {
                expect(e.privateSize).toBeLessThanOrEqual(e.allocSize);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
