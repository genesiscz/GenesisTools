import { describe, expect, it } from "bun:test";
import { buildVerdict, readTccCalendarRows, tccAuthLabel } from "./doctor";

describe("tccAuthLabel", () => {
    it("maps the kTCCServiceCalendar auth values", () => {
        expect(tccAuthLabel(0)).toBe("denied");
        expect(tccAuthLabel(2)).toBe("Full Access");
        expect(tccAuthLabel(4)).toBe("Add Only");
        expect(tccAuthLabel(9)).toContain("unknown");
    });
});

describe("buildVerdict", () => {
    it("tells a denied machine from an empty calendar", () => {
        const addOnly = buildVerdict({ status: "writeOnly", calendarCount: 1, placeholderOnly: true });
        expect(addOnly.verdict).toContain("Add Only");
        expect(addOnly.verdict).toContain("NOT an empty calendar");
        expect(addOnly.fix).toContain("Privacy & Security > Calendars");

        const empty = buildVerdict({ status: "fullAccess", calendarCount: 0, placeholderOnly: false });
        expect(empty.verdict).toContain("really is empty");
        expect(empty.fix).toBeUndefined();
    });

    it("reports the visible count under Full Access", () => {
        expect(buildVerdict({ status: "fullAccess", calendarCount: 40, placeholderOnly: false }).verdict).toContain(
            "40 calendars"
        );
    });
});

describe("readTccCalendarRows", () => {
    it("reports an unreadable database instead of an empty grant list", () => {
        const result = readTccCalendarRows("/nonexistent/dir/TCC.db");
        expect(result.readable).toBe(false);
        expect(result.rows).toEqual([]);
        expect(result.error).toBeTruthy();
    });
});
