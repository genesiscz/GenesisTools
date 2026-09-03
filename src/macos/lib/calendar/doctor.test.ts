import { describe, expect, it, test } from "bun:test";
import type { CalendarDoctorReport } from "./doctor";
import { buildVerdict, readTccCalendarRows, tccDecisionRecorded } from "./doctor";

// tccAuthLabel moved to ../permissions/tcc, where it takes the service so Calendar's
// "Add Only" can be told apart from a plain allow. Its tests moved with it.

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

describe("tccDecisionRecorded", () => {
    function tcc(rows: CalendarDoctorReport["tcc"]["rows"]): CalendarDoctorReport["tcc"] {
        return { readable: true, rows };
    }

    // TccRow is shared with the permissions report since the reader moved to ../permissions/tcc,
    // so a row now names its service as well.
    const row = {
        service: "kTCCServiceCalendar",
        client: "com.example.terminal",
        clientType: 0,
        authValue: 2,
        label: "Full Access",
        lastModified: "2026-09-03T00:00:00.000Z",
    };

    test("a recorded bundle-id row means reading the status cannot prompt", () => {
        expect(tccDecisionRecorded(tcc([row]), { bundleId: "com.example.terminal" })).toBe(true);
        // A denial is still a recorded answer.
        expect(tccDecisionRecorded(tcc([{ ...row, authValue: 0, label: "denied" }]), { bundleId: row.client })).toBe(
            true
        );
    });

    test("a path row matches only the launching executable", () => {
        const pathRow = { ...row, client: "/opt/homebrew/bin/bun", clientType: 1 };

        expect(tccDecisionRecorded(tcc([pathRow]), { executablePath: "/opt/homebrew/bin/bun" })).toBe(true);
        expect(tccDecisionRecorded(tcc([pathRow]), { executablePath: "/usr/bin/other" })).toBe(false);
        // Same string, wrong client_type: a bundle id is not a path.
        expect(tccDecisionRecorded(tcc([{ ...pathRow, clientType: 0 }]), { executablePath: pathRow.client })).toBe(
            false
        );
    });

    test("no row, or an unreadable TCC.db, counts as no decision", () => {
        expect(tccDecisionRecorded(tcc([]), { bundleId: "com.example.terminal" })).toBe(false);
        expect(
            tccDecisionRecorded({ readable: false, rows: [], error: "no Full Disk Access" }, { bundleId: row.client })
        ).toBe(false);
    });
});

describe("buildVerdict when the prompt was skipped", () => {
    test("says the status was not read and names the command that asks", () => {
        // CLAUDE.md: a diagnostic may READ durable state and REPORT on it, and
        // nothing else. The macOS Calendar dialog writes a durable TCC row.
        const verdict = buildVerdict({
            status: "notDetermined",
            calendarCount: 0,
            placeholderOnly: false,
            promptSkipped: true,
        });

        expect(verdict.verdict).toContain("did not ask");
        expect(verdict.fix).toContain("tools macos calendar list-calendars");
    });

    test("a recorded status still gets its normal verdict", () => {
        const verdict = buildVerdict({
            status: "fullAccess",
            calendarCount: 3,
            placeholderOnly: false,
            promptSkipped: false,
        });

        expect(verdict.verdict).toContain("3 calendars");
        expect(verdict.fix).toBeUndefined();
    });
});
