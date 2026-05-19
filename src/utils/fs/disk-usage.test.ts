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

import { spawnSync } from "node:child_process";
import { skip } from "@app/utils/test/skip";
import {
    exactReclaimableBytes,
    findCloneFamilies,
    reclaimableBytes,
} from "@app/utils/fs/disk-usage";

describe.skipIf(skip.unlessMac)("clone-family dedup (intra-tree)", () => {
    it("private undercounts a shared pair; exact ~= one copy; families grouped", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-du-clone-"));
        try {
            const a = join(dir, "a.bin");
            writeFileSync(a, Buffer.alloc(4 * 1024 * 1024, 9));
            expect(spawnSync("cp", ["-c", a, join(dir, "b.bin")]).status).toBe(0);

            const families = findCloneFamilies(dir);
            // both files share one clone id
            expect([...families.values()][0].length).toBe(2);

            const naive = reclaimableBytes(dir) as number;
            const exact = exactReclaimableBytes(dir) as number;
            // two fully-shared clones → little is private…
            expect(naive).toBeLessThan(1024 * 1024);
            // …but deleting the whole dir really frees ~one 4 MB copy
            expect(exact).toBeGreaterThan(3.5 * 1024 * 1024);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("reclaimable accessors degrade gracefully", () => {
    it("return null when private is unavailable (non-darwin)", () => {
        const r = reclaimableBytes("/this/does/not/exist");
        // missing path → no files measured → null/0 but never throws
        expect(r === null || r === 0).toBe(true);
    });
});

import {
    formatDiskUsage,
    freeDiskSpace,
    overcountRatio,
} from "@app/utils/fs/disk-usage";

describe("freeDiskSpace / overcountRatio / formatDiskUsage", () => {
    it("freeDiskSpace returns positive byte totals", () => {
        const s = freeDiskSpace("/");
        expect(s.total).toBeGreaterThan(0);
        expect(s.available).toBeGreaterThan(0);
        expect(s.total).toBeGreaterThanOrEqual(s.free);
    });

    it("overcountRatio is null when private unknown, else >= 1", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-du-ratio-"));
        try {
            writeFileSync(join(dir, "f"), Buffer.alloc(40_000, 1));
            const r = overcountRatio(dir);
            if (r !== null) {
                expect(r.ratio).toBeGreaterThanOrEqual(1);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("formatDiskUsage shows both numbers side by side", () => {
        const out = formatDiskUsage({
            logical: 1_000,
            allocated: 38_700_000_000,
            private: 2_100_000_000,
            exactReclaimable: 2_100_000_000,
            fileCount: 5,
            dirCount: 2,
            errors: [],
        });
        expect(out).toContain("du says");
        expect(out).toContain("actually");
    });
});
