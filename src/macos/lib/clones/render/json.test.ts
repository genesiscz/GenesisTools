import { describe, expect, it } from "bun:test";
import { JsonRenderer } from "@app/macos/lib/clones/render/json";
import { CLONES_GLOSSARY, type MeasureReport, type ProcessReport } from "@app/macos/lib/clones/render/types";
import { SafeJSON } from "@app/utils/json";

const measure: MeasureReport = {
    roots: ["/r"],
    nodeModulesMode: false,
    minReal: 10485760,
    tree: [],
    totals: { logical: 1000, allocated: 38700000000, real: 2100000000, overcount: 18.43 },
    cloneAnalysis: {
        families: 1,
        clonedFiles: 3402,
        sharedBytes: 9e9,
        crossTreePartners: ["~/.bun/install/cache"],
        notes: ["col-fe: du 14 GB → real 3.58 GB"],
    },
    freeSpace: { total: 1e12, free: 5e11, available: 4.9e11 },
    errors: [],
};

const proc: ProcessReport = {
    id: "2026-05-19T14-03-22Z.41109",
    state: "applied",
    roots: ["/r"],
    startedAt: "2026-05-19T14:03:22.000Z",
    endedAt: "2026-05-19T14:03:25.000Z",
    planCache: { hit: true, ageMs: 1234 },
    ops: [
        {
            seq: 1,
            ts: "2026-05-19T14:03:23.000Z",
            op: "clone",
            status: "ok",
            bytes: 1024,
            keep: "/r/a",
            replace: "/r/b",
            modeBefore: 0o644,
            mtimeBeforeMs: 1,
            sha256Before: "ab",
            sha256After: "ab",
        },
    ],
    totals: { cloned: 1, skipped: 0, errors: 0, bytesReclaimed: 1024 },
};

describe("JsonRenderer", () => {
    it("emits parseable JSON of the exact report object, no glossary", () => {
        const r = new JsonRenderer();
        const out = r.measure(measure);
        expect(SafeJSON.parse(out)).toEqual(measure as unknown as object);
        expect(out).not.toContain(CLONES_GLOSSARY.slice(0, 20));
    });

    it("processReport round-trips; jsonl emits one op per line", () => {
        const r = new JsonRenderer();
        expect(SafeJSON.parse(r.processReport(proc))).toEqual(proc as unknown as object);

        const lines = r.processReportJsonl(proc).trim().split("\n");
        expect(lines.length).toBe(1);
        expect(SafeJSON.parse(lines[0])).toEqual(proc.ops[0] as unknown as object);
    });
});
