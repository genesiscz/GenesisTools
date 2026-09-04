import { describe, expect, test } from "bun:test";
import { navigateToPeriodForDate } from "@app/clarity/lib/timesheet-weeks";

// A real carousel is a ~9 period window of consecutive weeks. Asking for a period id re-centres
// the window on it, so reaching a month a quarter back takes several hops, not one.
const WINDOW = 9;
const EPOCH_ID = 5000000;
const EPOCH_START = Date.UTC(2026, 0, 5); // Monday

function periodStart(id: number): string {
    return new Date(EPOCH_START + (id - EPOCH_ID) * 7 * 86_400_000).toISOString().slice(0, 10);
}

function fakeApi(currentId: number) {
    const asked: Array<number | undefined> = [];

    return {
        asked,
        // biome-ignore lint/suspicious/noExplicitAny: test double mirrors the Clarity response shape
        getTimesheetApp: async (timePeriodId?: number): Promise<any> => {
            asked.push(timePeriodId);
            const centre = timePeriodId ?? currentId;

            return {
                tscarousel: {
                    _results: Array.from({ length: WINDOW }, (_, i) => {
                        const id = centre - Math.floor(WINDOW / 2) + i;

                        return {
                            id,
                            start_date: `${periodStart(id)}T00:00:00`,
                            finish_date: `${periodStart(id + 1)}T00:00:00`,
                        };
                    }),
                },
            };
        },
    };
}

describe("navigateToPeriodForDate", () => {
    test("returns the seed window's own period when it already covers the date", async () => {
        const api = fakeApi(5000035);

        const id = await navigateToPeriodForDate({ api, seedTimePeriodId: 5000035, date: periodStart(5000035) });

        expect(id).toBe(5000035);
    });

    test("assigns the last day of a period to that period, not the next one", async () => {
        const api = fakeApi(5000035);
        const lastDay = new Date(Date.parse(`${periodStart(5000036)}T00:00:00Z`) - 86_400_000)
            .toISOString()
            .slice(0, 10);

        const id = await navigateToPeriodForDate({ api, seedTimePeriodId: 5000035, date: lastDay });

        expect(id).toBe(5000035);
    });

    test("reaches a period thirteen weeks back, which one window cannot span", async () => {
        const api = fakeApi(5000035);

        const id = await navigateToPeriodForDate({ api, seedTimePeriodId: 5000035, date: periodStart(5000022) });

        expect(id).toBe(5000022);
    });

    test("reaches a period far ahead of the seed", async () => {
        const api = fakeApi(5000035);

        const id = await navigateToPeriodForDate({ api, seedTimePeriodId: 5000035, date: periodStart(5000050) });

        expect(id).toBe(5000050);
    });

    test("takes more than one hop when the target is outside the first window", async () => {
        const api = fakeApi(5000035);

        await navigateToPeriodForDate({ api, seedTimePeriodId: 5000035, date: periodStart(5000022) });

        expect(api.asked.length).toBeGreaterThan(1);
    });

    // A window whose span contains the date but whose entries do not cover it has a hole in it.
    // Walking on would leave the target behind and spend every remaining hop for nothing.
    test("stops on a carousel gap rather than walking past the target", async () => {
        let calls = 0;
        const api = {
            // biome-ignore lint/suspicious/noExplicitAny: window with a missing middle week
            getTimesheetApp: async (): Promise<any> => {
                calls++;

                return {
                    tscarousel: {
                        _results: [
                            { id: 5000034, start_date: "2026-09-07T00:00:00", finish_date: "2026-09-14T00:00:00" },
                            { id: 5000036, start_date: "2026-09-21T00:00:00", finish_date: "2026-09-28T00:00:00" },
                        ],
                    },
                };
            },
        };

        expect(
            await navigateToPeriodForDate({ api, seedTimePeriodId: 5000034, date: "2026-09-16", maxHops: 12 })
        ).toBeUndefined();
        expect(calls).toBe(1);
    });

    test("gives up instead of looping when the date is unreachable", async () => {
        const api = {
            // biome-ignore lint/suspicious/noExplicitAny: a carousel that never moves
            getTimesheetApp: async (): Promise<any> => ({
                tscarousel: {
                    _results: [{ id: 5000035, start_date: "2026-09-07T00:00:00", finish_date: "2026-09-14T00:00:00" }],
                },
            }),
        };

        expect(
            await navigateToPeriodForDate({ api, seedTimePeriodId: 5000035, date: "2020-01-06", maxHops: 3 })
        ).toBeUndefined();
    });
});
