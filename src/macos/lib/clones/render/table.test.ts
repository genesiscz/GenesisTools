import { describe, expect, it } from "bun:test";
import { TableRenderer } from "@app/macos/lib/clones/render/table";
import type { DuplicatesReport, MeasureReport, ProcessReport } from "@app/macos/lib/clones/render/types";
import { stripAnsi } from "@app/utils/string";

const measure: MeasureReport = {
    roots: ["/projects"],
    nodeModulesMode: true,
    minReal: 10485760,
    tree: [
        {
            path: "/projects/app/node_modules",
            depth: 0,
            logical: 14_000_000_000,
            allocated: 14_000_000_000,
            real: 3_580_000_000,
            overcount: 3.91,
            children: [
                {
                    path: "/projects/app/node_modules/.cache",
                    depth: 1,
                    logical: 2e8,
                    allocated: 2e8,
                    real: 198_000_000,
                    overcount: 1.01,
                    children: [],
                },
            ],
            sharedNote: "3,402 files cloned from ~/.bun/install/cache → 0 B real",
        },
    ],
    totals: { logical: 14_000_000_000, allocated: 14_000_000_000, real: 3_580_000_000, overcount: 3.91 },
    cloneAnalysis: {
        families: 2,
        clonedFiles: 3402,
        sharedBytes: 1e10,
        crossTreePartners: ["~/.bun/install/cache"],
        notes: ["col-fe: du 14 GB → real 3.58 GB (cross-tree)"],
    },
    freeSpace: { total: 1e12, free: 5e11, available: 4.9e11 },
    errors: [{ path: "/projects/locked", errno: "EPERM" }],
};

const dups: DuplicatesReport = {
    roots: ["/projects"],
    sets: [
        {
            kind: "dir",
            what: "app/node_modules/lodash",
            copies: 3,
            eachBytes: 1_400_000,
            reclaimable: 2_800_000,
            members: ["/a/lodash", "/b/lodash", "/c/lodash"],
            keep: "/a/lodash",
        },
    ],
    totalReclaimable: 2_800_000,
    grouped: false,
    hardStop: ["/projects"],
};

const proc: ProcessReport = {
    id: "2026-05-19T14-03-22Z.41109",
    state: "applied",
    roots: ["/projects"],
    startedAt: "2026-05-19T14:03:22.000Z",
    endedAt: "2026-05-19T14:03:25.000Z",
    planCache: { hit: true, ageMs: 60000 },
    ops: [
        {
            seq: 1,
            ts: "t",
            op: "clone",
            status: "ok",
            bytes: 1_400_000,
            keep: "/a/x",
            replace: "/b/x",
            modeBefore: 420,
            mtimeBeforeMs: 1,
            sha256Before: "abcd",
            sha256After: "abcd",
        },
        {
            seq: 2,
            ts: "t",
            op: "skip",
            status: "already-cloned",
            bytes: 0,
            keep: "/a/y",
            replace: "/b/y",
            modeBefore: 420,
            mtimeBeforeMs: 1,
            sha256Before: "ef",
        },
        {
            seq: 3,
            ts: "t",
            op: "error",
            status: "errno:EACCES",
            bytes: 0,
            keep: "/a/z",
            replace: "/b/z",
            modeBefore: 420,
            mtimeBeforeMs: 1,
            sha256Before: "12",
            message: "permission denied",
        },
    ],
    totals: { cloned: 1, skipped: 1, errors: 1, bytesReclaimed: 1_400_000 },
};

describe("TableRenderer", () => {
    it("measure: tree rows indented by depth, totals, glossary footer present", () => {
        const out = stripAnsi(new TableRenderer().measure(measure));
        expect(out).toContain("node_modules");
        expect(out).toContain("  .cache");
        expect(out).toContain("cloned from ~/.bun/install/cache");
        expect(out).toContain("1 path(s) skipped");
        expect(out).toContain("ATTR_CMNEXT_PRIVATESIZE");
    });

    it("duplicates: set rows + reclaim total + glossary", () => {
        const out = stripAnsi(new TableRenderer().duplicates(dups));
        expect(out).toContain("app/node_modules/lodash");
        expect(out).toContain("ATTR_CMNEXT_PRIVATESIZE");
    });

    it("processReport: per-op table + skipped + errors + rollback suggestion, NO glossary", () => {
        const out = stripAnsi(new TableRenderer().processReport(proc));
        expect(out).toContain("clone");
        expect(out).toContain("Skipped");
        expect(out).toContain("already-cloned");
        expect(out).toContain("Errors");
        expect(out).toContain("permission denied");
        expect(out).toContain("tools macos clones optimize --rollback --process 2026-05-19T14-03-22Z.41109");
        expect(out).not.toContain("ATTR_CMNEXT_PRIVATESIZE");
    });
});
