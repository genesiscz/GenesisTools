import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collapseDuplicates } from "@app/macos/lib/clones/collapse";

function tree(base: string, name: string): void {
    mkdirSync(join(base, name, "lib"), { recursive: true });
    writeFileSync(join(base, name, "index.js"), Buffer.alloc(50_000, 1));
    writeFileSync(join(base, name, "lib", "a.js"), Buffer.alloc(40_000, 2));
}

describe("collapseDuplicates", () => {
    it("rolls identical dirs up to the whole-dir duplicate (not per-file)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-coll-"));
        try {
            mkdirSync(join(dir, "p1"), { recursive: true });
            mkdirSync(join(dir, "p2"), { recursive: true });
            tree(join(dir, "p1"), "dep");
            tree(join(dir, "p2"), "dep");

            const report = await collapseDuplicates({ roots: [dir] });
            expect(report.sets.length).toBe(1);
            const set = report.sets[0];
            expect(set.kind).toBe("dir");
            expect(set.copies).toBe(2);
            expect(set.what).toContain("dep");
            expect(set.members.sort()).toEqual([join(dir, "p1", "dep"), join(dir, "p2", "dep")].sort());
            expect(set.keep).toBe([join(dir, "p1", "dep"), join(dir, "p2", "dep")].sort()[0]);
            expect(set.reclaimable).toBe(set.eachBytes);
            expect(report.totalReclaimable).toBe(set.reclaimable);
            expect(report.hardStop).toEqual([dir]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("HARD STOP: never ascends above a scan root even when parent dirs match", async () => {
        const outer = mkdtempSync(join(tmpdir(), "gt-cl-hs-"));
        try {
            mkdirSync(join(outer, "shared", "r1"), { recursive: true });
            mkdirSync(join(outer, "shared", "r2"), { recursive: true });
            tree(join(outer, "shared", "r1"), "x");
            tree(join(outer, "shared", "r2"), "x");
            const r1 = join(outer, "shared", "r1");
            const r2 = join(outer, "shared", "r2");

            const report = await collapseDuplicates({ roots: [r1, r2] });
            const allPaths = report.sets.flatMap((s) => [s.what, ...s.members]).join("|");
            expect(allPaths).not.toContain(`${join(outer, "shared")}|`);
            for (const s of report.sets) {
                for (const m of s.members) {
                    expect(m.startsWith(r1) || m.startsWith(r2)).toBe(true);
                }
            }
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("count cheap-reject: dirs with different file counts are never whole-dir dupes", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-cr-"));
        try {
            mkdirSync(join(dir, "a"), { recursive: true });
            mkdirSync(join(dir, "b"), { recursive: true });
            writeFileSync(join(dir, "a", "f1"), Buffer.alloc(30_000, 9));
            writeFileSync(join(dir, "b", "f1"), Buffer.alloc(30_000, 9));
            writeFileSync(join(dir, "b", "extra"), Buffer.alloc(10, 1));
            const report = await collapseDuplicates({ roots: [dir] });
            const dirSets = report.sets.filter((s) => s.kind === "dir");
            expect(dirSets.length).toBe(0);
            expect(report.sets.some((s) => s.kind === "file")).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
