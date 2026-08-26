import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    listSegments,
    parseSegmentStart,
    pruneDecision,
    readEvents,
    type SegmentInfo,
    SegmentWriter,
    segmentName,
} from "./segments.ts";

const dirs: string[] = [];

function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "cdp-seg-"));
    dirs.push(dir);

    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

const seg = (startMs: number, bytes: number): SegmentInfo => ({
    path: `/x/${segmentName(startMs)}`,
    name: segmentName(startMs),
    startMs,
    bytes,
});

describe("segment names", () => {
    test("round-trip", () => {
        expect(parseSegmentStart(segmentName(1700000000000))).toBe(1700000000000);
        expect(parseSegmentStart("meta.json")).toBeNull();
        expect(parseSegmentStart("recorder.pid")).toBeNull();
    });
});

describe("pruneDecision", () => {
    const HOUR = 3_600_000;

    test("drops segments whose content is entirely older than maxAge, keeps the current one", () => {
        const now = 10 * HOUR;
        const segments = [seg(1 * HOUR, 10), seg(2 * HOUR, 10), seg(9 * HOUR, 10), seg(10 * HOUR - 1, 10)];
        const { drop, capDropped } = pruneDecision(segments, now, { maxAgeMs: 4 * HOUR, capBytes: 1e9 });
        expect(drop.map((s) => s.startMs)).toEqual([1 * HOUR, 2 * HOUR]);
        expect(capDropped).toBe(false);
    });

    test("byte cap drops the oldest early and reports it", () => {
        const now = 2 * HOUR;
        const segments = [seg(0, 600), seg(1 * HOUR, 300), seg(2 * HOUR - 1, 200)];
        const { drop, capDropped } = pruneDecision(segments, now, { maxAgeMs: 100 * HOUR, capBytes: 550 });
        expect(drop.map((s) => s.bytes)).toEqual([600]);
        expect(capDropped).toBe(true);
    });

    test("never drops the only remaining segment", () => {
        const { drop } = pruneDecision([seg(0, 9999)], 1, { maxAgeMs: 1, capBytes: 10 });
        expect(drop).toEqual([]);
    });
});

describe("SegmentWriter", () => {
    test("rotates on the interval and prunes old segments with one unlink at rotation", () => {
        const dir = tmp();
        let now = 1_000_000;
        const writer = new SegmentWriter(dir, { rotateMs: 1000, maxAgeMs: 2500, now: () => now });

        writer.write({ method: "A", params: {}, t: now });
        now += 1100;
        writer.write({ method: "B", params: {}, t: now });
        now += 1100;
        writer.write({ method: "C", params: {}, t: now });
        expect(listSegments(dir)).toHaveLength(3);

        // Jump far enough that everything but the fresh segment ages out.
        now += 5000;
        writer.write({ method: "D", params: {}, t: now });
        writer.close();

        const names = readdirSync(dir);
        expect(names).toHaveLength(1);
        const events = readEvents(dir);
        expect(events.map((e) => e.method)).toEqual(["D"]);
    });

    test("writes land in the buffer and read back in order across segments", () => {
        const dir = tmp();
        let now = 5_000_000;
        const writer = new SegmentWriter(dir, { rotateMs: 1000, maxAgeMs: 1e9, now: () => now });
        writer.write({ method: "one", params: { n: 1 }, t: now });
        now += 1500;
        writer.write({ method: "two", params: { n: 2 }, t: now });
        writer.close();

        expect(listSegments(dir)).toHaveLength(2);
        expect(readEvents(dir).map((e) => e.method)).toEqual(["one", "two"]);
        expect(readEvents(dir, { sinceMs: now - 100 }).map((e) => e.method)).toEqual(["two"]);
    });

    test("cap is a TOTAL-on-disk bound: active rotates at cap/2 and closed segments prune to cap/2", () => {
        const dir = tmp();
        const capBytes = 4000;
        let now = 9_000_000;
        // Clock advances 1ms per write so size-triggered rotations land in
        // DISTINCT segment files (rotateMs stays unreachable).
        const writer = new SegmentWriter(dir, { rotateMs: 1e9, maxAgeMs: 1e12, capBytes, now: () => now });

        for (let n = 0; n < 300; n++) {
            now += 1;
            writer.write({ method: "E", params: { pad: "x".repeat(20), n }, t: now });
        }

        writer.close();

        const totalBytes = listSegments(dir).reduce((sum, s) => sum + s.bytes, 0);
        // The on-disk total stays within the cap (small per-event slack) —
        // the old rotate-at-full-cap behavior peaked near 2x cap here.
        expect(totalBytes).toBeLessThanOrEqual(capBytes * 1.1);

        const events = readEvents(dir);
        // oldest events were cap-dropped and a marker recorded it
        expect(events.some((e) => e.method === "Genesis.marker")).toBe(true);
        expect(events.some((e) => (e.params as { n?: number }).n === 299)).toBe(true);
        expect(events.some((e) => (e.params as { n?: number }).n === 0)).toBe(false);
    });
});

describe("readEvents", () => {
    test("skips a broken jsonl line instead of aborting the dump", () => {
        const dir = tmp();
        writeFileSync(
            join(dir, segmentName(1)),
            ['{"method":"ok","params":{},"t":1}', "{not json", '{"method":"ok2","params":{},"t":2}'].join("\n")
        );
        expect(readEvents(dir).map((e) => e.method)).toEqual(["ok", "ok2"]);
    });
});
