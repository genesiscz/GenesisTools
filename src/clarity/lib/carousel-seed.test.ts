import { describe, expect, test } from "bun:test";
import { resolveCarouselSeed } from "@app/clarity/lib/timesheet-weeks";

// Period ids run consecutively, one per week. The live window is only ~9 periods wide, so the seed
// decides which window the walk starts from.
function carouselWindow(centreId: number) {
    return {
        tscarousel: {
            _results: Array.from({ length: 9 }, (_, i) => ({ id: centreId - 4 + i })),
        },
        timesheets: { _results: [{ timePeriodId: centreId }] },
    };
}

function fakeApi(currentId: number) {
    const asked: Array<number | undefined> = [];

    return {
        asked,
        // biome-ignore lint/suspicious/noExplicitAny: test double mirrors the Clarity response shape
        getTimesheetApp: async (timePeriodId?: number): Promise<any> => {
            asked.push(timePeriodId);

            return carouselWindow(timePeriodId ?? currentId);
        },
    };
}

describe("resolveCarouselSeed", () => {
    test("takes the server's current period", async () => {
        const api = fakeApi(5008042);

        expect(await resolveCarouselSeed({ api })).toBe(5008042);
    });

    test("asks the server with no filter, so the answer is never a stale window", async () => {
        const api = fakeApi(5008042);

        await resolveCarouselSeed({ api });

        expect(api.asked).toEqual([undefined]);
    });

    test("returns undefined when the server offers no period at all", async () => {
        const api = {
            // biome-ignore lint/suspicious/noExplicitAny: empty-response double
            getTimesheetApp: async (): Promise<any> => ({ tscarousel: { _results: [] }, timesheets: { _results: [] } }),
        };

        expect(await resolveCarouselSeed({ api })).toBeUndefined();
    });
});

describe("resolveCarouselSeed carousel fallback", () => {
    test("prefers the active period over the oldest one when no timesheet is reported", async () => {
        const api = {
            // biome-ignore lint/suspicious/noExplicitAny: carousel-only response
            getTimesheetApp: async (): Promise<any> => ({
                timesheets: { _results: [] },
                tscarousel: {
                    _results: [
                        { id: 5000031, is_active: false },
                        { id: 5000035, is_active: false },
                        { id: 5000039, is_active: true },
                    ],
                },
            }),
        };

        expect(await resolveCarouselSeed({ api })).toBe(5000039);
    });
});
