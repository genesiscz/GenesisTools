import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMeasureReport, expandNodeModules, resolveRoots } from "@app/macos/lib/clones/orchestrator";
import { SafeJSON } from "@app/utils/json";
import { skip } from "@app/utils/test/skip";

describe("resolveRoots", () => {
    it("explicit roots win; absolute-resolved; falls back to cwd", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-roots-"));
        try {
            expect(resolveRoots([dir], [])).toEqual([dir]);
            expect(resolveRoots([], ["/tmp"])).toEqual(["/tmp"]);
            const fellBack = resolveRoots([], []);
            expect(fellBack).toEqual([process.cwd()]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("expandNodeModules", () => {
    it("finds node_modules dirs and prunes nested ones", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-nm-"));
        try {
            mkdirSync(join(dir, "a", "node_modules", "x"), { recursive: true });
            mkdirSync(join(dir, "b", "node_modules"), { recursive: true });
            const found = expandNodeModules([dir]).sort();
            expect(found).toEqual([join(dir, "a", "node_modules"), join(dir, "b", "node_modules")].sort());
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe.skipIf(skip.unlessMac)("buildMeasureReport keep rule", () => {
    it("keeps dirs with real>minReal; collapses pass-through; keeps spread-across-small parent", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-meas-"));
        try {
            mkdirSync(join(dir, "big", "heavy"), { recursive: true });
            writeFileSync(join(dir, "big", "heavy", "f.bin"), Buffer.alloc(12 * 1024 * 1024, 1));
            mkdirSync(join(dir, "cache", "s1"), { recursive: true });
            mkdirSync(join(dir, "cache", "s2"), { recursive: true });
            writeFileSync(join(dir, "cache", "s1", "a"), Buffer.alloc(6 * 1024 * 1024, 2));
            writeFileSync(join(dir, "cache", "s2", "b"), Buffer.alloc(6 * 1024 * 1024, 3));
            mkdirSync(join(dir, "tiny"), { recursive: true });
            writeFileSync(join(dir, "tiny", "t"), Buffer.alloc(1024, 4));

            const rep = buildMeasureReport({ roots: [dir], minReal: 10 * 1024 * 1024, breakdown: true });
            expect(rep.roots).toEqual([dir]);
            const paths = SafeJSON.stringify(rep.tree);
            expect(paths).toContain("heavy");
            expect(paths).not.toMatch(/"path":"[^"]*\/big"/);
            expect(paths).toContain("cache");
            expect(paths).not.toContain("tiny");
            expect(rep.totals.real === null || rep.totals.real >= 0).toBe(true);
            expect(rep.freeSpace.total).toBeGreaterThan(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("--no-breakdown emits totals + cloneAnalysis only (empty tree)", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-nb-"));
        try {
            mkdirSync(join(dir, "sub"), { recursive: true });
            writeFileSync(join(dir, "sub", "f"), Buffer.alloc(20 * 1024 * 1024, 1));
            const rep = buildMeasureReport({ roots: [dir], minReal: 1024, breakdown: false });
            expect(rep.tree).toEqual([]);
            expect(rep.totals.logical).toBeGreaterThan(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("cross-tree shared bytes: file cloned from OUTSIDE the scan root reports sharedBytes>0 + sharedNote", () => {
        const out = mkdtempSync(join(tmpdir(), "gt-cl-cts-out-"));
        const inn = mkdtempSync(join(tmpdir(), "gt-cl-cts-in-"));
        try {
            const payload = Buffer.alloc(2 * 1024 * 1024, 0x5a);
            writeFileSync(join(out, "external.bin"), payload);
            // Clone INTO the measured root; the partner stays outside it.
            expect(spawnSync("cp", ["-c", join(out, "external.bin"), join(inn, "intree.bin")]).status).toBe(0);
            // Add an independent local file so the dir clears minReal and is
            // kept by pruneTree — the cross-tree clone alone would have ~0 real.
            writeFileSync(join(inn, "local.bin"), Buffer.alloc(5 * 1024 * 1024, 0x9b));

            const rep = buildMeasureReport({ roots: [inn], minReal: 1024, breakdown: true });
            expect(rep.cloneAnalysis.sharedBytes).toBeGreaterThan(1024 * 1024);
            expect(rep.cloneAnalysis.notes.join(" ")).toMatch(/cross-tree|outside/i);
            const treeJson = SafeJSON.stringify(rep.tree);
            expect(treeJson).toMatch(/sharedNote/);
            expect(treeJson).toMatch(/shared with cross-tree/);

            // Once BOTH copies are in-scope, they form an intra-tree family and
            // sharedBytes drops back to 0 (no external partner anymore).
            const repBoth = buildMeasureReport({ roots: [out, inn], minReal: 1024, breakdown: true });
            expect(repBoth.cloneAnalysis.sharedBytes).toBe(0);
        } finally {
            rmSync(out, { recursive: true, force: true });
            rmSync(inn, { recursive: true, force: true });
        }
    });

    it("include/exclude globs filter by relpath OR basename; exclude wins", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-glob-"));
        try {
            mkdirSync(join(dir, "keepme"), { recursive: true });
            mkdirSync(join(dir, "dropme"), { recursive: true });
            writeFileSync(join(dir, "keepme", "a"), Buffer.alloc(20 * 1024 * 1024, 1));
            writeFileSync(join(dir, "dropme", "b"), Buffer.alloc(20 * 1024 * 1024, 2));
            const rep = buildMeasureReport({
                roots: [dir],
                minReal: 1024,
                breakdown: true,
                exclude: ["dropme"],
            });
            const s = SafeJSON.stringify(rep.tree);
            expect(s).toContain("keepme");
            expect(s).not.toContain("dropme");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
