import { describe, expect, test } from "bun:test";
import {
    groupEventsByDay,
    isInvertedWindow,
    isSentinelDate,
    localDay,
    parseDayBoundary,
    realDayCount,
    resolveUpdateDate,
    UNDATED_DAY,
    withinDayWindow,
} from "@app/azure-devops/lib/activity-days";
import type { WorkItemUpdate } from "@app/azure-devops/types";
import { withTimeZone } from "@genesiscz/utils/test/timezone";

function update(overrides: Partial<WorkItemUpdate>): WorkItemUpdate {
    return {
        id: 1,
        workItemId: 700001,
        rev: 2,
        revisedBy: { displayName: "Alice Example", uniqueName: "alice@example.com" },
        revisedDate: "2026-03-04T09:10:11Z",
        url: "https://example.invalid/workItems/700001/updates/1",
        ...overrides,
    };
}

describe("resolveUpdateDate", () => {
    test("uses revisedDate when it is a real date", () => {
        expect(resolveUpdateDate(update({}))).toBe("2026-03-04T09:10:11Z");
    });

    test("falls back to the changed date when revisedDate is the far-future sentinel", () => {
        const resolved = resolveUpdateDate(
            update({
                revisedDate: "9999-01-01T00:00:00Z",
                fields: { "System.ChangedDate": { oldValue: "", newValue: "2026-03-05T12:00:00Z" } },
            })
        );

        expect(resolved).toBe("2026-03-05T12:00:00Z");
    });

    test("falls back to the authorized date when there is no changed date", () => {
        const resolved = resolveUpdateDate(
            update({
                revisedDate: "9999-01-01T00:00:00Z",
                fields: { "System.AuthorizedDate": { oldValue: "", newValue: "2026-03-06T08:00:00Z" } },
            })
        );

        expect(resolved).toBe("2026-03-06T08:00:00Z");
    });

    test("reports no date rather than the sentinel when nothing usable is present", () => {
        expect(resolveUpdateDate(update({ revisedDate: "9999-01-01T00:00:00Z" }))).toBe("");
    });

    test("never returns a sentinel date from a fallback field either", () => {
        const resolved = resolveUpdateDate(
            update({
                revisedDate: "9999-01-01T00:00:00Z",
                fields: { "System.ChangedDate": { oldValue: "", newValue: "9999-01-01T00:00:00Z" } },
            })
        );

        expect(resolved).toBe("");
    });
});

describe("isSentinelDate", () => {
    test("recognises the far-future stamp and nothing else", () => {
        expect(isSentinelDate("9999-01-01T00:00:00Z")).toBe(true);
        expect(isSentinelDate("2026-03-04T09:10:11Z")).toBe(false);
        expect(isSentinelDate(undefined)).toBe(false);
    });
});

describe("groupEventsByDay", () => {
    test("returns one row per day, oldest first", () => {
        const days = groupEventsByDay([
            { date: "2026-03-05T10:00:00Z" },
            { date: "2026-03-04T10:00:00Z" },
            { date: "2026-03-04T18:00:00Z" },
        ]);

        expect(days.map((day) => day.date)).toEqual(["2026-03-04", "2026-03-05"]);
        expect(days[0].events.length).toBe(2);
    });

    test("puts a sentinel date in the undated bucket instead of a far-future day row", () => {
        const days = groupEventsByDay([{ date: "2026-03-04T10:00:00Z" }, { date: "9999-01-01T00:00:00Z" }]);

        expect(days.map((day) => day.date)).toEqual(["2026-03-04", UNDATED_DAY]);
        expect(days.some((day) => day.date.startsWith("9999"))).toBe(false);
    });

    test("puts an empty or unparseable date in the same undated bucket", () => {
        const days = groupEventsByDay([{ date: "" }, { date: "not a date" }, { date: "2026-03-04T10:00:00Z" }]);

        expect(days.map((day) => day.date)).toEqual(["2026-03-04", UNDATED_DAY]);
        expect(days[1].events.length).toBe(2);
    });

    test("labels the undated bucket in words rather than as a weekday", () => {
        const days = groupEventsByDay([{ date: "9999-01-01T00:00:00Z" }]);

        expect(days[0].dayName).toBe("no date recorded");
    });
});

describe("realDayCount", () => {
    test("counts day rows and never the undated bucket", () => {
        const days = groupEventsByDay([
            { date: "2026-03-04T10:00:00Z" },
            { date: "2026-03-05T10:00:00Z" },
            { date: "9999-01-01T00:00:00Z" },
        ]);

        expect(days.length).toBe(3);
        expect(realDayCount(days)).toBe(2);
    });
});

describe("withinDayWindow", () => {
    const from = new Date("2026-09-01T00:00:00Z");
    const to = new Date("2026-09-30T23:59:59.999Z");

    test("keeps an event inside the window, both bounds inclusive", () => {
        expect(withinDayWindow("2026-09-15T12:00:00Z", from, to)).toBe(true);
        expect(withinDayWindow("2026-09-01T00:00:00Z", from, to)).toBe(true);
        expect(withinDayWindow("2026-09-30T23:59:59.999Z", from, to)).toBe(true);
    });

    test("drops an event outside either bound", () => {
        expect(withinDayWindow("2026-08-31T23:59:59Z", from, to)).toBe(false);
        expect(withinDayWindow("2026-10-01T00:00:00Z", from, to)).toBe(false);
    });

    test("drops an undated event once a window is asked for", () => {
        // `new Date("")` compares false against BOTH bounds, so the inline comparison this
        // replaced let every undated update through whatever window was requested.
        expect(withinDayWindow("", from, undefined)).toBe(false);
        expect(withinDayWindow("", undefined, to)).toBe(false);
        expect(withinDayWindow("not a date", from, to)).toBe(false);
    });

    test("drops the far-future sentinel from a window that ends before it", () => {
        expect(withinDayWindow("9999-01-01T00:00:00Z", from, to)).toBe(false);
    });

    test("keeps an undated event when no window was asked for", () => {
        expect(withinDayWindow("", undefined, undefined)).toBe(true);
        expect(withinDayWindow("not a date", undefined, undefined)).toBe(true);
    });
});

describe("parseDayBoundary", () => {
    test("reads a bare date as that calendar day in the local timezone", () => {
        const start = parseDayBoundary("2026-09-14");

        expect(start.getFullYear()).toBe(2026);
        expect(start.getMonth()).toBe(8);
        expect(start.getDate()).toBe(14);
        expect(start.getHours()).toBe(0);
        expect(start.getMinutes()).toBe(0);
    });

    test("clamps the end of the day to the day that was asked for", () => {
        // `new Date("2026-09-14")` is UTC midnight, which west of Greenwich is already the 13th.
        // Clamping THAT gave 23:59 on the 13th and dropped the whole requested day.
        const end = parseDayBoundary("2026-09-14", { endOfDay: true });

        expect(end.getDate()).toBe(14);
        expect(end.getMonth()).toBe(8);
        expect(end.getHours()).toBe(23);
        expect(end.getMinutes()).toBe(59);
        expect(end.getSeconds()).toBe(59);
    });

    test("covers the whole requested day, start before end", () => {
        const start = parseDayBoundary("2026-09-14");
        const end = parseDayBoundary("2026-09-14", { endOfDay: true });

        expect(start.getTime()).toBeLessThan(end.getTime());
        expect(end.getTime() - start.getTime()).toBe(86_400_000 - 1);
    });

    test("leaves a value that carries its own time to Date", () => {
        const at = parseDayBoundary("2026-09-14T08:30:00Z");

        expect(at.toISOString()).toBe("2026-09-14T08:30:00.000Z");
    });

    test("rejects an out-of-range date instead of rolling it over into another year", () => {
        // The numeric Date constructor turns 2026-13-45 into 14 February 2027. The string form
        // this replaced was an Invalid Date, and the callers already report that as a bad --from.
        expect(Number.isNaN(parseDayBoundary("2026-13-45").getTime())).toBe(true);
        expect(Number.isNaN(parseDayBoundary("2026-02-30").getTime())).toBe(true);
        expect(Number.isNaN(parseDayBoundary("2026-00-10").getTime())).toBe(true);
    });

    test("accepts a real leap day and the last day of a month", () => {
        expect(parseDayBoundary("2028-02-29").getDate()).toBe(29);
        expect(parseDayBoundary("2026-12-31").getDate()).toBe(31);
    });

    test("reports an unparseable value as an Invalid Date rather than guessing", () => {
        expect(Number.isNaN(parseDayBoundary("not a date").getTime())).toBe(true);
    });
});

describe("isInvertedWindow", () => {
    const from = new Date("2026-09-14T00:00:00Z");
    const to = new Date("2026-09-07T23:59:59Z");

    test("spots a window whose end precedes its start", () => {
        expect(isInvertedWindow(from, to)).toBe(true);
    });

    test("accepts a window in the right order, and one that covers a single instant", () => {
        expect(isInvertedWindow(to, from)).toBe(false);
        expect(isInvertedWindow(from, from)).toBe(false);
    });

    test("accepts a half-open window, since one bound cannot be out of order", () => {
        expect(isInvertedWindow(from, undefined)).toBe(false);
        expect(isInvertedWindow(undefined, to)).toBe(false);
        expect(isInvertedWindow(undefined, undefined)).toBe(false);
    });
});

describe("localDay", () => {
    // `withTimeZone`, not a hand-rolled TZ save/restore: see iterations.test.ts for why that
    // latches the wrong zone into the rest of the worker.
    const withTz = withTimeZone;

    test("answers with the calendar day that was typed, whatever the timezone is", () => {
        // The bug this guards: `parseDayBoundary` returns a LOCAL moment, so reporting it with
        // `toISOString().slice(0, 10)` printed 2026-09-13 under TZ=Europe/Prague and, for the end
        // of the same day, 2026-09-15 under TZ=America/Chicago. Both zones must be pinned here:
        // the round trip through local getters alone holds under ANY timezone, including the
        // UTC that CI defaults to, so an un-pinned assertion would pass just as well against the
        // buggy `toISOString()` form.
        withTz("Europe/Prague", () => {
            expect(localDay(parseDayBoundary("2026-09-14"))).toBe("2026-09-14");
        });

        withTz("America/Chicago", () => {
            expect(localDay(parseDayBoundary("2026-09-14", { endOfDay: true }))).toBe("2026-09-14");
        });
    });

    test("pads the month and the day to two digits", () => {
        expect(localDay(parseDayBoundary("2026-01-02"))).toBe("2026-01-02");
    });

    test("covers a day either side of a UTC boundary, which is where the old form broke", () => {
        withTz("Europe/Prague", () => {
            expect(localDay(parseDayBoundary("2026-12-31"))).toBe("2026-12-31");
        });

        withTz("America/Chicago", () => {
            expect(localDay(parseDayBoundary("2027-01-01", { endOfDay: true }))).toBe("2027-01-01");
        });
    });
});
