import { describe, expect, it } from "bun:test";
import { fixtureDashboardClient } from "@/api/fixture-wire";
import { MOCK_TIMESHEET } from "@/api/fixtures/timesheet";
import { acceptedForRevision, allAccepted, dayLine, fillWeek, hours, localDay, weekQuery } from "@/features/timesheet/queries";

describe("the Friday timesheet", () => {
    it("requires a new review after a stale fill is refused and the same task codes refresh", () => {
        const review = { revision: MOCK_TIMESHEET.revision, codes: new Set(MOCK_TIMESHEET.rows.map((row) => row.code)) };
        expect(allAccepted(MOCK_TIMESHEET, acceptedForRevision(MOCK_TIMESHEET, review))).toBe(true);
        const refreshed = { ...MOCK_TIMESHEET, revision: "new-revision" };
        expect(allAccepted(refreshed, acceptedForRevision(refreshed, review))).toBe(false);
        const next = { revision: refreshed.revision, codes: new Set([refreshed.rows[0]!.code]) };
        expect(allAccepted(refreshed, acceptedForRevision(refreshed, next))).toBe(false);
    });

    it("reads the week and sends the fill with the revision it showed", async () => {
        const week = await weekQuery(fixtureDashboardClient, "2026-09-30").queryFn?.({} as never);
        const receipt = await fillWeek(fixtureDashboardClient, {
            date: "2026-09-30",
            timesheetId: 9001,
            revision: "fixture-rev",
            idempotencyKey: "k1",
        });

        expect(week).toEqual(MOCK_TIMESHEET);
        expect(receipt.filled).toBe(false);
    });

    it("fills only after every row was accepted, and words the hours", () => {
        expect(allAccepted(MOCK_TIMESHEET, new Set(["T-100"]))).toBe(false);
        expect(allAccepted(MOCK_TIMESHEET, new Set(["T-100", "T-200"]))).toBe(true);
        expect(allAccepted(null, new Set())).toBe(false);
        expect(hours(450)).toBe("7.50 h");
        expect(hours(60)).toBe("1 h");
        expect(dayLine(MOCK_TIMESHEET.rows[0])).toBe("Tue 4 h · Wed 3.50 h");
        expect(localDay(new Date(2026, 0, 5))).toBe("2026-01-05");
    });
});
