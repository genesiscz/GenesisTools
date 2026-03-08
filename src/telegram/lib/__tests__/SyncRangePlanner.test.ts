import { describe, expect, it } from "bun:test";
import { SyncRangePlanner } from "../SyncRangePlanner";

describe("SyncRangePlanner", () => {
    it("returns full range when no segments exist", () => {
        const plan = SyncRangePlanner.plan([], 1700000000, 1700259200);
        expect(plan.length).toBe(1);
        expect(plan[0]).toEqual({ from: 1700000000, to: 1700259200 });
    });

    it("returns empty when fully covered", () => {
        const segments = [{ from_date_unix: 1700000000, to_date_unix: 1700259200 }];
        const plan = SyncRangePlanner.plan(segments, 1700000000, 1700259200);
        expect(plan.length).toBe(0);
    });

    it("finds gap between two segments", () => {
        const segments = [
            { from_date_unix: 1700000000, to_date_unix: 1700086400 },
            { from_date_unix: 1700172800, to_date_unix: 1700259200 },
        ];
        const plan = SyncRangePlanner.plan(segments, 1700000000, 1700259200);
        expect(plan.length).toBe(1);
        expect(plan[0]).toEqual({ from: 1700086400, to: 1700172800 });
    });

    it("finds gap before first segment", () => {
        const segments = [{ from_date_unix: 1700086400, to_date_unix: 1700259200 }];
        const plan = SyncRangePlanner.plan(segments, 1700000000, 1700259200);
        expect(plan.length).toBe(1);
        expect(plan[0].from).toBe(1700000000);
    });

    it("finds gap after last segment", () => {
        const segments = [{ from_date_unix: 1700000000, to_date_unix: 1700086400 }];
        const plan = SyncRangePlanner.plan(segments, 1700000000, 1700259200);
        expect(plan.length).toBe(1);
        expect(plan[0].from).toBe(1700086400);
    });

    it("handles overlapping segments", () => {
        const segments = [
            { from_date_unix: 1700000000, to_date_unix: 1700100000 },
            { from_date_unix: 1700050000, to_date_unix: 1700259200 },
        ];
        const plan = SyncRangePlanner.plan(segments, 1700000000, 1700259200);
        expect(plan.length).toBe(0);
    });
});
