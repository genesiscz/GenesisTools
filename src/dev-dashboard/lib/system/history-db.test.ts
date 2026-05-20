import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { downsamplePoints, PulseHistoryDb } from "./history-db";

describe("PulseHistoryDb", () => {
    let db: PulseHistoryDb;

    beforeEach(() => {
        db = new PulseHistoryDb(":memory:");
    });

    afterEach(() => {
        db.close();
    });

    test("downsamplePoints averages buckets", () => {
        const points = [
            { ts: "2026-01-01T00:00:00.000Z", value: 10 },
            { ts: "2026-01-01T00:00:05.000Z", value: 20 },
            { ts: "2026-01-01T00:00:10.000Z", value: 30 },
            { ts: "2026-01-01T00:00:15.000Z", value: 40 },
        ];

        expect(downsamplePoints(points, 2)).toEqual([
            { ts: "2026-01-01T00:00:05.000Z", value: 15 },
            { ts: "2026-01-01T00:00:15.000Z", value: 35 },
        ]);
    });

    test("record then series returns ascending points within window", () => {
        db.record("cpu", 12.5);
        db.record("cpu", 30);
        const points = db.series("cpu", 60);
        expect(points.length).toBe(2);
        expect(points[0].value).toBe(12.5);
        expect(points[1].value).toBe(30);
        expect(points[0].ts <= points[1].ts).toBe(true);
    });

    test("series filters by metric", () => {
        db.record("cpu", 1);
        db.record("mem", 2);
        expect(db.series("mem", 60).map((p) => p.value)).toEqual([2]);
    });

    test("pruneOlderThan removes stale rows and returns count", () => {
        const old = new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString();
        db.recordAt("cpu", 99, old);
        db.record("cpu", 10);
        const removed = db.pruneOlderThan(24);
        expect(removed).toBe(1);
        expect(db.series("cpu", 60 * 24 * 7).length).toBe(1);
    });

    test("series downsamples long ranges", () => {
        for (let i = 0; i < 1000; i++) {
            db.recordAt("cpu", i, new Date(Date.now() - (999 - i) * 1000).toISOString());
        }

        const points = db.series("cpu", 60 * 24, 360);
        expect(points.length).toBeLessThanOrEqual(360);
        expect(points.length).toBeGreaterThan(0);
    });

    test("public ip cache respects freshness", () => {
        expect(db.getPublicIp(1000)).toBeNull();
        db.setPublicIp("1.2.3.4");
        expect(db.getPublicIp(60_000)).toBe("1.2.3.4");
        expect(db.getPublicIp(-1)).toBeNull();
    });
});
