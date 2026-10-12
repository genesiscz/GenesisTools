import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type AutoReclaimDeps,
    formatAutoReclaimReport,
    limitPlan,
    parseByteLimit,
    runAutoReclaims,
} from "@app/macos/lib/clones/auto-reclaim";
import type { Preset, PresetAuto } from "@app/macos/lib/clones/presets";
import type { ReclaimPlan } from "@app/macos/lib/clones/reclaim";
import type { DuplicateSet } from "@app/macos/lib/clones/render/types";
import { formatScanReport, reclaimableByRoot, runDaemonScan } from "@app/macos/lib/clones/scan-daemon";

describe("runDaemonScan", () => {
    it("empty watchedDirs → returns scanned:false, writes nothing, no throw", async () => {
        const res = await runDaemonScan({ watchedDirs: [], notify: false });
        expect(res.scanned).toBe(false);
        expect(formatScanReport(res)[0]).toContain("no watched folders are configured");
    });

    it("reports per watched folder what is reclaimable, the plan it wrote and the time", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-scan-report-"));
        try {
            const work = join(dir, "work");
            const shop = join(dir, "shop");
            mkdirSync(work);
            mkdirSync(shop);
            writeFileSync(join(work, "model.bin"), Buffer.alloc(64_000, 7));
            writeFileSync(join(shop, "model.bin"), Buffer.alloc(64_000, 7));

            const res = await runDaemonScan({ watchedDirs: [work, shop], notify: false, minReal: 4096 });

            expect(res.scanned).toBe(true);
            expect(res.sets).toBe(1);
            expect(res.reclaimable).toBe(64_000);
            expect(res.planKey).toBeTruthy();
            // The kept copy is the first by path (shop/…), so the copy in work/ is the one that would be replaced.
            expect(res.roots).toEqual([
                { root: work, reclaimable: 64_000, sets: 1 },
                { root: shop, reclaimable: 0, sets: 0 },
            ]);
            const report = formatScanReport(res).join("\n");
            expect(report).toContain("2 watched folders");
            expect(report).toContain(`${work}: 62.5 KB reclaimable in 1 duplicate set`);
            expect(report).toContain(`${shop}: nothing reclaimable`);
            expect(report).toContain("total: 62.5 KB reclaimable in 1 duplicate set");
            expect(report).toContain(`plan written: dry-run plan snapshot ${res.planKey}`);
            expect(report).toMatch(/time: /);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("reclaimableByRoot", () => {
    it("counts each replaced copy for the folder it sits in, and never the kept copy", () => {
        const roots = ["/w/a", "/w/b", "/w/a/deep"];
        const rows = reclaimableByRoot(
            [
                {
                    kind: "file",
                    what: "x",
                    copies: 3,
                    eachBytes: 10,
                    reclaimable: 20,
                    keep: "/w/a/x",
                    members: ["/w/a/x", "/w/b/x", "/w/a/deep/x"],
                },
            ],
            roots
        );

        expect(rows).toEqual([
            { root: "/w/a", reclaimable: 0, sets: 0 },
            { root: "/w/b", reclaimable: 10, sets: 1 },
            { root: "/w/a/deep", reclaimable: 10, sets: 1 },
        ]);
    });
});

// ─── auto reclaim ─────────────────────────────────────────────────────────────

const GB = 1024 ** 3;

function dupSet(name: string, eachBytes: number, copies: number): DuplicateSet {
    const members = Array.from({ length: copies }, (_, i) => `/w/${name}/${i}.bin`);
    return {
        kind: "file",
        what: name,
        copies,
        eachBytes,
        reclaimable: eachBytes * (copies - 1),
        members,
        keep: members[0] ?? "",
    };
}

function fakePlan(dirs: string[], sets: DuplicateSet[]): ReclaimPlan {
    const total = sets.reduce((sum, set) => sum + set.reclaimable, 0);
    return {
        runId: `run-${dirs[0]}`,
        selector: { dirs, targets: [], exclude: [], minReal: 1, keepPartners: [] },
        roots: dirs,
        rootStamps: [],
        skipped: [],
        keepRoots: [],
        sets,
        totalReclaimable: total,
        totalFreeable: total,
        totalFreeableUpTo: total,
        dropped: { sets: 0, naiveBytes: 0 },
        fromSnapshot: false,
        deniedDirs: 0,
    };
}

function preset(id: string, auto?: PresetAuto): Preset {
    return {
        id,
        dirs: [`/w/${id}`],
        targets: [],
        exclude: [],
        minReal: 1,
        keepPartners: [],
        createdAt: "2026-10-01T00:00:00.000Z",
        ...(auto ? { auto } : {}),
    };
}

/** Deps whose apply THROWS for a preset that is not marked auto, and records every plan it clones. */
function autoDeps(presets: Preset[], sets: DuplicateSet[]) {
    const applied: ReclaimPlan[] = [];
    const planned: string[] = [];
    const saved: Array<{ id: string; auto: PresetAuto }> = [];
    const deps: AutoReclaimDeps = {
        presets: () => presets,
        plan: async (selector) => {
            planned.push(selector.dirs[0] ?? "");
            return { status: "ok", plan: fakePlan(selector.dirs, sets) };
        },
        apply: (plan) => {
            const owner = presets.find((p) => p.dirs[0] === plan.roots[0]);
            if (owner?.auto?.enabled !== true) {
                throw new Error(`apply reached a plan that is not marked auto: ${plan.roots[0]}`);
            }

            applied.push(plan);
            const bytes = plan.sets.reduce((sum, set) => sum + set.reclaimable, 0);
            const files = plan.sets.reduce((sum, set) => sum + set.copies - 1, 0);
            return {
                status: "ok",
                report: {
                    id: "proc-1",
                    state: "applied",
                    roots: plan.roots,
                    startedAt: "2026-10-12T03:00:00.000Z",
                    endedAt: "2026-10-12T03:01:00.000Z",
                    planCache: { hit: false },
                    ops: [],
                    totals: { cloned: files, skipped: 0, errors: 0, bytesReclaimed: bytes },
                },
            };
        },
        saveAuto: (id, auto) => {
            saved.push({ id, auto });
        },
        touch: () => {},
        now: () => new Date("2026-10-12T03:00:00.000Z"),
    };
    return { deps, applied, planned, saved };
}

const ARMED: PresetAuto = { enabled: true, maxBytes: 4 * GB, maxFiles: 10, dryRunAt: "2026-10-11T03:00:00.000Z" };

describe("auto reclaim", () => {
    const sets = [dupSet("big", 3 * GB, 2), dupSet("mid", 2 * GB, 2), dupSet("small", 0.5 * GB, 3)];

    it("an auto plan clones only the sets within its limits and the report says what, why and how much", async () => {
        const { deps, applied } = autoDeps([preset("work", ARMED)], sets);
        const outcomes = await runAutoReclaims({ deps });

        // 3 GB (1 file) + 1 GB (2 files) fit 4 GB; the 2 GB set would pass the byte limit.
        expect(applied).toHaveLength(1);
        expect(applied[0]?.sets.map((set) => set.what)).toEqual(["big", "small"]);
        expect(outcomes[0]).toMatchObject({
            preset: "work",
            action: "applied",
            planned: { sets: 3, bytes: 6 * GB },
            withinLimits: { sets: 2, bytes: 4 * GB, files: 3 },
            applied: { cloned: 3, bytesReclaimed: 4 * GB, errors: 0 },
        });
        const report = formatAutoReclaimReport(outcomes).join("\n");
        expect(report).toContain("auto reclaim: 1 plan marked auto");
        expect(report).toContain("work: applied, 3 files cloned, 4.0 GB reclaimed, 0 skipped, 0 errors");
        expect(report).toContain(
            "the plan found 6.0 GB in 3 sets; 2 sets, 3 files, 4.0 GB fit the limits 4.0 GB, 10 files"
        );
    });

    it("a plan without the auto flag is never planned or cloned", async () => {
        const { deps, applied, planned } = autoDeps(
            [preset("shop"), preset("side", { ...ARMED, enabled: false }), preset("work", ARMED)],
            sets
        );
        const outcomes = await runAutoReclaims({ deps });

        expect(planned).toEqual(["/w/work"]);
        expect(applied.map((plan) => plan.roots[0])).toEqual(["/w/work"]);
        expect(outcomes.map((o) => o.preset)).toEqual(["work"]);
    });

    it("the first run after arming is a dry run that records itself; a --auto-dry-run run never clones", async () => {
        const fresh = autoDeps([preset("work", { enabled: true, maxBytes: 4 * GB, maxFiles: 10 })], sets);
        const first = await runAutoReclaims({ deps: fresh.deps });
        expect(first[0]?.action).toBe("dry-run");
        expect(fresh.applied).toEqual([]);
        expect(fresh.saved).toEqual([
            {
                id: "work",
                auto: { enabled: true, maxBytes: 4 * GB, maxFiles: 10, dryRunAt: "2026-10-12T03:00:00.000Z" },
            },
        ]);

        const armed = autoDeps([preset("work", ARMED)], sets);
        const dry = await runAutoReclaims({ deps: armed.deps, dryRun: true });
        expect(dry[0]?.action).toBe("dry-run");
        expect(armed.applied).toEqual([]);
        expect(armed.saved).toEqual([]);
    });

    it("the scan task leaves the auto plans alone unless its caller asks, and reports them when it does", async () => {
        const { deps, planned } = autoDeps([preset("work", ARMED)], sets);
        const off = await runDaemonScan({ watchedDirs: [], notify: false, autoDeps: deps });
        expect(off.auto).toBeNull();
        expect(planned).toEqual([]);

        const on = await runDaemonScan({ watchedDirs: [], notify: false, autoDeps: deps, autoReclaim: "dry-run" });
        expect(on.auto?.map((o) => o.action)).toEqual(["dry-run"]);
        expect(formatScanReport(on).join("\n")).toContain("work: dry run, nothing cloned");
    });

    it("limits and sizes", () => {
        const limited = limitPlan(fakePlan(["/w/x"], sets), { maxBytes: 100 * GB, maxFiles: 2 });
        expect(limited.plan.sets.map((set) => set.what)).toEqual(["big", "mid"]);
        expect(limited.droppedSets).toBe(1);
        expect(parseByteLimit("5GB")).toBe(5 * GB);
        expect(parseByteLimit("500 mb")).toBe(500 * 1024 ** 2);
        expect(parseByteLimit("1048576")).toBe(1048576);
        expect(parseByteLimit("lots")).toBeNull();
        expect(parseByteLimit("0")).toBeNull();
    });
});
