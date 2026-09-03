import { describe, expect, test } from "bun:test";
import { resolveCarouselSeed } from "@app/clarity/lib/timesheet-weeks";

// Period ids run consecutively, one per week. The live window is only ~9 periods wide, so a month
// further back than that is unreachable unless the seed comes from the server.
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
    test("uses a mapping's cached timesheet period when one exists", async () => {
        const api = fakeApi(5008042);

        const seed = await resolveCarouselSeed({ api, cachedTimePeriodId: 5008010 });

        expect(seed).toBe(5008010);
    });

    test("falls back to the server's current period when no mapping carries one", async () => {
        const api = fakeApi(5008042);

        const seed = await resolveCarouselSeed({ api, cachedTimePeriodId: undefined });

        expect(seed).toBe(5008042);
    });

    test("asks the server with no filter when it has nothing to seed from", async () => {
        const api = fakeApi(5008042);

        await resolveCarouselSeed({ api, cachedTimePeriodId: undefined });

        expect(api.asked).toEqual([undefined]);
    });

    test("does not call the server when a cached period is already known", async () => {
        const api = fakeApi(5008042);

        await resolveCarouselSeed({ api, cachedTimePeriodId: 5008010 });

        expect(api.asked).toEqual([]);
    });

    test("returns undefined when the server offers no period at all", async () => {
        const api = {
            // biome-ignore lint/suspicious/noExplicitAny: empty-response double
            getTimesheetApp: async (): Promise<any> => ({ tscarousel: { _results: [] }, timesheets: { _results: [] } }),
        };

        expect(await resolveCarouselSeed({ api, cachedTimePeriodId: undefined })).toBeUndefined();
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
                        { id: 5000035, is_active: true },
                        { id: 5000039, is_active: false },
                    ],
                },
            }),
        };

        expect(await resolveCarouselSeed({ api, cachedTimePeriodId: undefined })).toBe(5000035);
    });
});
