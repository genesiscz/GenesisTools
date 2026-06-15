import { describe, expect, it } from "bun:test";
import { convert, formatZoneLine, renderZone } from "./lib/convert";
import { parseExpression } from "./lib/parse";

const NOW_MS = Date.UTC(2026, 5, 2, 12, 0, 0); // 2026-06-02T12:00:00Z
const LOCAL = "Europe/Prague";

describe("renderZone", () => {
    it("renders a ZoneLine for an epoch in a target zone", () => {
        // 23:00Z === 01:00 next day in Prague (CEST)
        const line = renderZone(Date.UTC(2026, 5, 2, 23, 0, 0), "Europe/Prague", "Europe/Prague");
        expect(line.zone).toBe("Europe/Prague");
        expect(line.time).toBe("01:00");
        expect(line.weekday).toBe("Wed");
        expect(line.offset).toBe("GMT+2");
    });
});

describe("parseExpression", () => {
    it("branch (a): chrono-certain zone — uses chrono's epoch", () => {
        // 3pm PST (UTC-8) === 23:00Z
        const r = parseExpression({ expr: "3pm PST", nowMs: NOW_MS, localZone: LOCAL });
        expect(new Date(r.epochMs).toISOString()).toBe("2026-06-02T23:00:00.000Z");
        expect(r.target).toBeUndefined();
    });

    it("'now' resolves to the injected instant (anchored to the reference)", () => {
        const r = parseExpression({ expr: "now in Tokyo", nowMs: NOW_MS, localZone: LOCAL });
        expect(r.epochMs).toBe(NOW_MS);
        expect(r.target).toBe("Asia/Tokyo");
    });

    it("a relative expression ('in 2 hours') is offset from the reference", () => {
        const r = parseExpression({ expr: "in 2 hours", nowMs: NOW_MS, localZone: LOCAL });
        expect(new Date(r.epochMs).toISOString()).toBe("2026-06-02T14:00:00.000Z");
    });

    it("captures an explicit 'in <zone>' target", () => {
        const r = parseExpression({ expr: "3pm PST in Prague", nowMs: NOW_MS, localZone: LOCAL });
        expect(new Date(r.epochMs).toISOString()).toBe("2026-06-02T23:00:00.000Z");
        expect(r.target).toBe("Europe/Prague");
    });

    it("branch (c): wall-clock + explicit source 'to' target", () => {
        // 09:00 in Europe/Prague (CEST) === 07:00Z; target New York
        const r = parseExpression({
            expr: "2026-06-02 09:00 Europe/Prague to America/New_York",
            nowMs: NOW_MS,
            localZone: LOCAL,
        });
        expect(new Date(r.epochMs).toISOString()).toBe("2026-06-02T07:00:00.000Z");
        expect(r.target).toBe("America/New_York");
    });

    it("branch (c): bare time with no zone uses localZone", () => {
        // 9:00 with no zone, local = Prague (CEST) === 07:00Z
        const r = parseExpression({ expr: "9:00", nowMs: NOW_MS, localZone: LOCAL });
        expect(new Date(r.epochMs).toISOString()).toBe("2026-06-02T07:00:00.000Z");
        expect(r.target).toBeUndefined();
    });

    it("throws on an unparseable expression", () => {
        expect(() => parseExpression({ expr: "wibble wobble", nowMs: NOW_MS, localZone: LOCAL })).toThrow();
    });
});

describe("convert", () => {
    it("renders an explicit target only", () => {
        const r = convert({ expr: "3pm PST in Prague", nowMs: NOW_MS, localZone: LOCAL });
        expect(r.lines).toHaveLength(1);
        expect(r.lines[0].zone).toBe("Europe/Prague");
        expect(r.lines[0].time).toBe("01:00");
        expect(r.lines[0].offset).toBe("GMT+2");
    });

    it("converts a wall-clock source zone to a target zone", () => {
        const r = convert({
            expr: "2026-06-02 09:00 Europe/Prague to America/New_York",
            nowMs: NOW_MS,
            localZone: LOCAL,
        });
        expect(r.lines).toHaveLength(1);
        expect(r.lines[0].zone).toBe("America/New_York");
        expect(r.lines[0].time).toBe("03:00");
        expect(r.lines[0].offset).toBe("GMT-4");
    });

    it("uses the default zone set when no target is given (Local first)", () => {
        const r = convert({ expr: "3pm PST", nowMs: NOW_MS, localZone: LOCAL });
        expect(r.lines.length).toBeGreaterThan(1);
        expect(r.lines[0].label).toBe("Local (Europe/Prague)");
        const zones = r.lines.map((l) => l.zone);
        expect(zones).toContain("UTC");
        expect(zones).toContain("Asia/Tokyo");
    });

    it("honours an explicit --to list", () => {
        const r = convert({ expr: "3pm PST", nowMs: NOW_MS, localZone: LOCAL, to: ["Tokyo", "UTC"] });
        expect(r.lines.map((l) => l.zone)).toEqual(["Asia/Tokyo", "UTC"]);
    });
});

describe("formatZoneLine", () => {
    it("formats a ZoneLine as 'label  weekday, date  time  (offset)'", () => {
        const r = convert({ expr: "3pm PST in Prague", nowMs: NOW_MS, localZone: LOCAL });
        const text = formatZoneLine(r.lines[0]);
        expect(text).toContain("Europe/Prague");
        expect(text).toContain("Wed");
        expect(text).toContain("01:00");
        expect(text).toContain("(GMT+2)");
    });
});
