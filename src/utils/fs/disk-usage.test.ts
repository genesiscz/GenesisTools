import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
    fileAllocatedSize,
    fileLogicalSize,
    walkFiles,
} from "@app/utils/fs/disk-usage";

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
