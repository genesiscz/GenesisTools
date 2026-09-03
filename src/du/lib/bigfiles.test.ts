import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listBigFiles } from "@app/du/lib/engine";
import { skip } from "@genesiscz/utils/test/skip";

const MB = 1 << 20;

describe.skipIf(skip.onWindows || process.platform !== "darwin")("listBigFiles (clonesize --bigfiles)", () => {
    it("lists files at or above the floor across roots, prunes by name, never follows symlinks", async () => {
        const outer = mkdtempSync(join(tmpdir(), "gt-bigfiles-"));
        try {
            const a = join(outer, "a");
            const b = join(outer, "b");
            mkdirSync(join(a, "sub"), { recursive: true });
            mkdirSync(join(a, ".git"), { recursive: true });
            mkdirSync(b, { recursive: true });
            writeFileSync(join(a, "big.bin"), Buffer.alloc(2 * MB, 1));
            writeFileSync(join(a, "small.bin"), Buffer.alloc(MB - 1, 2));
            writeFileSync(join(a, "sub", "nested.bin"), Buffer.alloc(3 * MB, 3));
            writeFileSync(join(a, ".git", "pack.bin"), Buffer.alloc(4 * MB, 4));
            writeFileSync(join(b, "exact.bin"), Buffer.alloc(MB, 5));
            symlinkSync(join(a, "sub"), join(b, "link-to-sub"));

            const r = await listBigFiles({ roots: [a, b], minBytes: MB, pruneNames: [".git"] });

            expect(r.files.map((f) => f.path)).toEqual([
                join(a, "big.bin"),
                join(a, "sub", "nested.bin"),
                join(b, "exact.bin"),
            ]);
            expect(r.files[0]?.size).toBe(2 * MB);
            expect(r.files[0]?.mtimeNs).toBeGreaterThan(1_000_000_000_000_000_000n);
            expect(r.files[0]?.nlink).toBe(1);
            // small.bin, big.bin, nested.bin, exact.bin; the pruned pack.bin is never listed
            expect(r.filesListed).toBe(4);
            expect(r.dirs).toBe(3);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("an aborted signal kills the walk and rejects with the abort reason", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-bigfiles-abort-"));
        try {
            writeFileSync(join(dir, "x.bin"), Buffer.alloc(MB, 1));
            const ac = new AbortController();
            ac.abort(new Error("stop"));
            await expect(listBigFiles({ roots: [dir], minBytes: MB, signal: ac.signal })).rejects.toThrow("stop");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("reports the roots it accepted and no read errors", async () => {
        const outer = mkdtempSync(join(tmpdir(), "gt-bigfiles-roots-"));
        try {
            const roots: string[] = [];
            for (let i = 0; i < 4_100; i++) {
                const dir = join(outer, `r${i}`);
                mkdirSync(dir, { recursive: true });
                writeFileSync(join(dir, "f.bin"), Buffer.alloc(MB, 7));
                roots.push(dir);
            }

            const r = await listBigFiles({ roots, minBytes: MB });
            expect(r.roots).toBe(4_100);
            expect(r.files.length).toBe(4_100);
            expect(r.readErrors).toBe(0);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    }, 120_000);

    it("does not descend into a mount point that belongs to another volume", async () => {
        // The simulator runtime volumes are the only foreign mounts every dev
        // machine has; without the prune this walk lists a million files.
        const mounts = "/Library/Developer/CoreSimulator/Volumes";
        if (!existsSync(mounts) || readdirSync(mounts).length === 0) {
            return;
        }

        const r = await listBigFiles({ roots: [mounts], minBytes: 1 });
        expect(r.filesListed).toBe(0);
    }, 60_000);
});
