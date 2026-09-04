import { describe, expect, it } from "bun:test";
import { formatLocalDay, parseMailDate, resolveListFilters } from "./command-helpers";

describe("parseMailDate", () => {
    it("treats 14h as fourteen hours before now", () => {
        const before = Date.now();
        const parsed = parseMailDate("14h");
        const after = Date.now();
        const fourteenHours = 14 * 60 * 60 * 1000;

        expect(parsed).toBeInstanceOf(Date);
        expect(parsed!.getTime()).toBeGreaterThanOrEqual(before - fourteenHours);
        expect(parsed!.getTime()).toBeLessThanOrEqual(after - fourteenHours);
    });

    it("treats 7d as seven days before now", () => {
        const before = Date.now();
        const parsed = parseMailDate("7d");
        const after = Date.now();
        const sevenDays = 7 * 24 * 60 * 60 * 1000;

        expect(parsed!.getTime()).toBeGreaterThanOrEqual(before - sevenDays);
        expect(parsed!.getTime()).toBeLessThanOrEqual(after - sevenDays);
    });

    it("treats now as the current instant", () => {
        const before = Date.now();
        const parsed = parseMailDate("now");
        const after = Date.now();

        expect(parsed!.getTime()).toBeGreaterThanOrEqual(before);
        expect(parsed!.getTime()).toBeLessThanOrEqual(after);
    });

    it("treats a date-only from as local midnight, not UTC", () => {
        const parsed = parseMailDate("2026-04-09");

        expect(parsed!.getFullYear()).toBe(2026);
        expect(parsed!.getMonth()).toBe(3);
        expect(parsed!.getDate()).toBe(9);
        expect(parsed!.getHours()).toBe(0);
        expect(parsed!.getMinutes()).toBe(0);
        expect(parsed!.getSeconds()).toBe(0);
        expect(parsed!.getMilliseconds()).toBe(0);
    });

    it("treats a date-only to as local end of that day", () => {
        const parsed = parseMailDate("2026-04-09", true);

        expect(parsed!.getFullYear()).toBe(2026);
        expect(parsed!.getMonth()).toBe(3);
        expect(parsed!.getDate()).toBe(9);
        expect(parsed!.getHours()).toBe(23);
        expect(parsed!.getMinutes()).toBe(59);
        expect(parsed!.getSeconds()).toBe(59);
        expect(parsed!.getMilliseconds()).toBe(999);
    });

    it("keeps an explicit ISO instant", () => {
        expect(parseMailDate("2026-04-09T12:00:00.000Z")?.toISOString()).toBe("2026-04-09T12:00:00.000Z");
    });

    it("rejects a bare number so it is not treated as minutes", () => {
        expect(() => parseMailDate("30")).toThrow(/Invalid date/);
    });

    it("rejects garbage", () => {
        expect(() => parseMailDate("last week")).toThrow(/Invalid date/);
    });

    it("returns undefined for a missing value", () => {
        expect(parseMailDate(undefined)).toBeUndefined();
    });
});

describe("resolveListFilters", () => {
    it("maps --from 14h into a Date about fourteen hours ago", () => {
        const before = Date.now();
        const { filters } = resolveListFilters({ from: "14h" });
        const after = Date.now();
        const fourteenHours = 14 * 60 * 60 * 1000;

        expect(filters.from!.getTime()).toBeGreaterThanOrEqual(before - fourteenHours);
        expect(filters.from!.getTime()).toBeLessThanOrEqual(after - fourteenHours);
    });

    it("sets unread when --unread is passed", () => {
        expect(resolveListFilters({ unread: true }).filters.unread).toBe(true);
        expect(resolveListFilters({ unread: true }).filters.read).toBeUndefined();
    });

    it("rejects --read and --unread together", () => {
        expect(() => resolveListFilters({ read: true, unread: true })).toThrow(/either --read or --unread/);
    });

    it("maps --has-attachment onto hasAttachment", () => {
        expect(resolveListFilters({ hasAttachment: true }).filters.hasAttachment).toBe(true);
    });

    it("parses --offset as a non-negative integer", () => {
        expect(resolveListFilters({ offset: "40" }).offset).toBe(40);
        expect(() => resolveListFilters({ offset: "-1" })).toThrow(/Invalid --offset/);
    });
});

describe("formatLocalDay", () => {
    // The regression: `--from 2026-04-09` parses to local midnight, and
    // toISOString().slice(0, 10) rendered it back as 2026-04-08 east of UTC —
    // in the confirmation for a destructive rebuild.
    it("echoes the day the user typed, not the UTC one", () => {
        const parsed = parseMailDate("2026-04-09");
        expect(parsed).toBeDefined();
        expect(formatLocalDay(parsed!)).toBe("2026-04-09");
    });

    it("echoes an end-of-day bound as the same calendar day", () => {
        const parsed = parseMailDate("2026-04-09", true);
        expect(formatLocalDay(parsed!)).toBe("2026-04-09");
    });

    it("pads single-digit months and days", () => {
        expect(formatLocalDay(new Date(2026, 0, 5, 12, 0, 0))).toBe("2026-01-05");
    });
});
