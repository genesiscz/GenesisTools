import { describe, expect, test } from "bun:test";
import { buildPeriodComment, buildWeekComment } from "@app/clarity/lib/comment-builder";

const ENTRIES = [
    { workItemId: 111111, timeTypeDescription: "Development", comment: "první úkol", date: "2026-08-24" },
    { workItemId: 222222, timeTypeDescription: "Ceremonie", comment: "SU", date: "2026-08-24" },
    { workItemId: 111111, timeTypeDescription: "Development", comment: "druhý den", date: "2026-08-30" },
    { workItemId: 333333, timeTypeDescription: "Development", comment: "mimo období", date: "2026-08-31" },
    { workItemId: 444444, timeTypeDescription: "Development", comment: "před obdobím", date: "2026-08-23" },
];

describe("buildWeekComment", () => {
    test("groups entries under a Czech day heading, one line per entry", () => {
        const text = buildWeekComment([ENTRIES[0], ENTRIES[1]]);

        expect(text).toBe("Po, 24.8.:\n - #111111 - Development - první úkol\n - #222222 - Ceremonie - SU");
    });

    test("returns an empty string when there is nothing to say", () => {
        expect(buildWeekComment([])).toBe("");
    });
});

describe("buildPeriodComment", () => {
    // timePeriodFinish names the last day of the period, so 2026-08-30 belongs to the week and
    // 2026-08-31 does not. Getting that wrong pulls the next week's work into this note.
    test("keeps only the entries inside the period, finish day included", () => {
        const text = buildPeriodComment({
            entries: ENTRIES,
            periodStart: "2026-08-24T00:00:00",
            periodFinishInclusive: "2026-08-30T00:00:00",
        });

        expect(text).toBe(
            [
                "Po, 24.8.:",
                " - #111111 - Development - první úkol",
                " - #222222 - Ceremonie - SU",
                "Ne, 30.8.:",
                " - #111111 - Development - druhý den",
            ].join("\n")
        );
    });

    test("excludes the day after the finish date", () => {
        const text = buildPeriodComment({
            entries: ENTRIES,
            periodStart: "2026-08-24T00:00:00",
            periodFinishInclusive: "2026-08-30T00:00:00",
        });

        expect(text).not.toContain("#333333");
    });

    test("excludes the day before the start date", () => {
        const text = buildPeriodComment({
            entries: ENTRIES,
            periodStart: "2026-08-24T00:00:00",
            periodFinishInclusive: "2026-08-30T00:00:00",
        });

        expect(text).not.toContain("#444444");
    });

    test("returns an empty string when no entry falls in the period", () => {
        const text = buildPeriodComment({
            entries: ENTRIES,
            periodStart: "2026-12-01T00:00:00",
            periodFinishInclusive: "2026-12-07T00:00:00",
        });

        expect(text).toBe("");
    });
});
