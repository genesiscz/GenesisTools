import { describe, expect, test } from "bun:test";
import { spendBucketKey } from "./series-keys";

/**
 * Counts how many `Intl.DateTimeFormat` objects `body` builds.
 *
 * A Proxy keeps the constructor's own type, so the global stays assignable and
 * no cast is needed. Restored in `finally`: the global is process-wide and bun
 * runs many test files per process.
 */
function countFormatters(body: () => void): number {
    const real = Intl.DateTimeFormat;
    let built = 0;

    Intl.DateTimeFormat = new Proxy(real, {
        construct(target, args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
            built += 1;

            return new target(...args);
        },
        apply(target, _thisArg, args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
            built += 1;

            return target(...args);
        },
    });

    try {
        body();
    } finally {
        Intl.DateTimeFormat = real;
    }

    return built;
}

describe("spendBucketKey formatter reuse", () => {
    test("a zone builds one formatter, however many events are bucketed", () => {
        // Two zones no other test in this file has warmed.
        const fresh = countFormatters(() => {
            for (let i = 0; i < 50; i++) {
                spendBucketKey(`2026-03-02T09:${String(i % 60).padStart(2, "0")}:00.000Z`, "hour", "Australia/Eucla");
            }
        });

        expect(fresh).toBe(1);

        // Warm now: the whole point is that the second query pays nothing.
        const warm = countFormatters(() => {
            for (let i = 0; i < 50; i++) {
                spendBucketKey(`2026-03-03T09:${String(i % 60).padStart(2, "0")}:00.000Z`, "hour", "Australia/Eucla");
            }
        });

        expect(warm).toBe(0);
    });

    test("a second zone gets its own formatter, so keys never come from the wrong one", () => {
        const built = countFormatters(() => {
            spendBucketKey("2026-03-02T23:30:00.000Z", "hour", "Pacific/Kiritimati");
        });

        expect(built).toBe(1);
        // Kiritimati is UTC+14, Eucla UTC+8:45: the same instant, two civil days.
        expect(spendBucketKey("2026-03-02T23:30:00.000Z", "day", "Pacific/Kiritimati")).toBe("2026-03-03");
        expect(spendBucketKey("2026-03-02T23:30:00.000Z", "day", "Australia/Eucla")).toBe("2026-03-03");
        expect(spendBucketKey("2026-03-02T23:30:00.000Z", "hour", "Pacific/Kiritimati")).toBe("2026-03-03T13");
        expect(spendBucketKey("2026-03-02T23:30:00.000Z", "hour", "Australia/Eucla")).toBe("2026-03-03T08");
    });

    test("an unusable timestamp is still the empty string, and builds nothing", () => {
        const built = countFormatters(() => {
            expect(spendBucketKey("not-a-date", "day", "UTC")).toBe("");
        });

        expect(built).toBe(0);
    });
});
