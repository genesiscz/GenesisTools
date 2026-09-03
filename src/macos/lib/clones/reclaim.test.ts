import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSelector, planReclaim } from "@app/macos/lib/clones/reclaim";
import { readReclaimEvents, reclaimRunPath } from "@app/macos/lib/clones/reclaim-run";

function twoTrees(): string {
    const outer = mkdtempSync(join(tmpdir(), "gt-cl-reclaim-"));
    for (const name of ["w1", "w2"]) {
        const dep = join(outer, name, "node_modules", "dep");
        mkdirSync(join(dep, "lib"), { recursive: true });
        writeFileSync(join(dep, "index.js"), Buffer.alloc(50_000, 1));
        writeFileSync(join(dep, "lib", "a.js"), Buffer.alloc(40_000, 2));
    }

    return outer;
}

function dropRunLog(runId: string): void {
    if (runId !== "" && existsSync(reclaimRunPath(runId))) {
        rmSync(reclaimRunPath(runId));
    }
}

describe("defaultSelector", () => {
    it("defaults to gitignored install trees with no keep partners", () => {
        expect(defaultSelector(["/tmp/x"])).toEqual({
            dirs: ["/tmp/x"],
            targets: ["gitignored"],
            exclude: [],
            minReal: 10485760,
            keepPartners: [],
        });
    });
});

describe("planReclaim", () => {
    it("finds the duplicate shared by two sibling trees and logs the run", async () => {
        const outer = twoTrees();
        let runId = "";
        try {
            const phases: string[] = [];
            const plan = await planReclaim(
                { ...defaultSelector([outer]), minReal: 1024 },
                { onPhase: (phase) => phases.push(phase) }
            );
            runId = plan.runId;

            // Discovery realpaths every dir; on macOS `/var` links to `/private/var`.
            const real = realpathSync(outer);
            expect(plan.roots.sort()).toEqual(
                [join(real, "w1", "node_modules"), join(real, "w2", "node_modules")].sort()
            );
            expect(plan.sets.length).toBe(1);
            expect(plan.sets[0].copies).toBe(2);
            expect(plan.totalReclaimable).toBe(plan.sets[0].eachBytes);
            expect(plan.keepRoots).toEqual([]);
            expect(plan.fromSnapshot).toBe(false);
            expect(phases).toEqual(["discover", "walk", "hash", "collapse"]);
            expect(plan.rootStamps.map((s) => s.path).sort()).toEqual([...plan.roots].sort());
            expect(plan.rootStamps.every((s) => s.mtimeMs >= 0)).toBe(true);

            const events = readReclaimEvents(plan.runId).map((e) => e.phase);
            expect(events).toEqual(["start", "discover", "collapse", "plan"]);
        } finally {
            dropRunLog(runId);
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("hands the discovered roots to onDiscovered before the collapse", async () => {
        const outer = twoTrees();
        let runId = "";
        try {
            const order: string[] = [];
            let handed: string[] = [];
            const plan = await planReclaim(
                { ...defaultSelector([outer]), minReal: 1024 },
                {
                    onPhase: (phase) => order.push(phase),
                    onDiscovered: async (roots) => {
                        handed = [...roots];
                        order.push("onDiscovered");
                    },
                }
            );
            runId = plan.runId;
            expect(handed.sort()).toEqual([...plan.roots].sort());
            expect(order).toEqual(["discover", "onDiscovered", "cache", "walk", "hash", "collapse"]);
        } finally {
            dropRunLog(runId);
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("reuses a snapshot when the hook returns sets, and skips the scan", async () => {
        const outer = twoTrees();
        let runId = "";
        try {
            const canned = [
                {
                    kind: "file" as const,
                    what: "x",
                    copies: 2,
                    eachBytes: 7,
                    reclaimable: 7,
                    members: ["/a/x", "/b/x"],
                    keep: "/a/x",
                },
            ];
            const seenRoots: string[][] = [];
            const plan = await planReclaim(
                { ...defaultSelector([outer]), minReal: 1024 },
                {
                    snapshot: (roots) => {
                        seenRoots.push(roots);
                        return canned;
                    },
                }
            );
            runId = plan.runId;
            expect(seenRoots.length).toBe(1);
            expect(seenRoots[0].length).toBe(2);
            expect(plan.fromSnapshot).toBe(true);
            expect(plan.sets).toEqual(canned);
            expect(plan.totalReclaimable).toBe(7);
            expect(readReclaimEvents(plan.runId).map((e) => e.phase)).toEqual(["start", "discover", "plan"]);
        } finally {
            dropRunLog(runId);
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("reports skipped roots instead of failing when a dir does not exist", async () => {
        const plan = await planReclaim({ ...defaultSelector(["/definitely/not/here/gt-reclaim"]), minReal: 1024 });
        try {
            expect(plan.roots).toEqual([]);
            expect(plan.sets).toEqual([]);
            expect(plan.skipped).toEqual([{ path: "/definitely/not/here/gt-reclaim", reason: "missing" }]);
        } finally {
            dropRunLog(plan.runId);
        }
    });
});
