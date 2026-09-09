import { describe, expect, test } from "bun:test";
import type { LimitWindow } from "@genesiscz/utils/ai/providers/account-features";
import { formatMoney, percentOf } from "./format-money";

/**
 * `snapshots.json` is cast straight back into `AccountUsageSnapshot` with no validation and
 * kept for a year, so a row a pre-fix build wrote without `percentUsed` still reaches every
 * renderer. `tools ai accounts show` reads that file and never polls, so a producer fix alone
 * does not reach it.
 */
describe("percentOf", () => {
    test("a real percentage passes through", () => {
        expect(percentOf({ percentUsed: 42.5 })).toBe(42.5);
        expect(percentOf({ percentUsed: 0 })).toBe(0);
        expect(percentOf({ percentUsed: 140 })).toBe(140);
    });

    test("a value no renderer could print reads as 0", () => {
        expect(percentOf({})).toBe(0);
        expect(percentOf({ percentUsed: undefined })).toBe(0);
        expect(percentOf({ percentUsed: Number.NaN })).toBe(0);
        expect(percentOf({ percentUsed: Number.POSITIVE_INFINITY })).toBe(0);
        expect(percentOf({ percentUsed: "12" as unknown as number })).toBe(0);
    });

    test("a window off the cache with no percentUsed at all is printable", () => {
        const fromDisk = {
            key: "product:grokimagine",
            label: "Grok Imagine",
            kind: "scoped",
            resetsAt: "2026-09-16T00:00:00.000Z",
        } as unknown as LimitWindow;

        expect(() => percentOf(fromDisk).toFixed(1)).not.toThrow();
        expect(percentOf(fromDisk).toFixed(1)).toBe("0.0");
    });
});

describe("formatMoney", () => {
    test("a window with no money has no money line", () => {
        expect(formatMoney({ key: "five_hour", label: "5h", kind: "session", percentUsed: 1 })).toBeNull();
    });
});
