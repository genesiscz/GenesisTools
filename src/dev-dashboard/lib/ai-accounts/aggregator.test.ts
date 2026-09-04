import { describe, expect, test } from "bun:test";
import { defaultSeriesStep, transcriptScanKey } from "@app/dev-dashboard/lib/ai-accounts/aggregator";

const WINDOW = { from: "2026-08-05T19:00:00.000Z", to: "2026-09-04T19:00:00.000Z", source: "transcripts" } as const;

/**
 * The 30-day preset blocked the server for tens of seconds and 502'd unrelated
 * endpoints (sweep 2026-09-04, defect 3). The scan itself is upstream; what the
 * dashboard controls is not asking for it twice and not asking the limits store
 * for an unbounded number of points.
 */
describe("transcriptScanKey", () => {
    test("the totals request and the series request over one window share a key", () => {
        expect(transcriptScanKey(WINDOW, "day")).toBe(transcriptScanKey({ ...WINDOW }, "day"));
    });

    test("a minute request keys as hour, because transcripts cannot answer finer", () => {
        expect(transcriptScanKey(WINDOW, "minute")).toBe(transcriptScanKey(WINDOW, "hour"));
    });

    test("a different window is a different scan", () => {
        expect(transcriptScanKey(WINDOW, "day")).not.toBe(
            transcriptScanKey({ ...WINDOW, to: "2026-09-04T20:00:00.000Z" }, "day")
        );
    });

    test("the account filter is part of the key, and its order is not", () => {
        const a = transcriptScanKey({ ...WINDOW, accounts: ["acc_work", "acc_shop"] }, "day");
        const b = transcriptScanKey({ ...WINDOW, accounts: ["acc_shop", "acc_work"] }, "day");

        expect(a).toBe(b);
        expect(a).not.toBe(transcriptScanKey(WINDOW, "day"));
    });
});

describe("defaultSeriesStep", () => {
    test("caps a 30-day window at 600 buckets", () => {
        const step = defaultSeriesStep(WINDOW.from, WINDOW.to);

        expect(step).toBeDefined();
        expect(Math.round((Date.parse(WINDOW.to) - Date.parse(WINDOW.from)) / (step ?? 1))).toBe(600);
    });

    test("an hour window steps finer than the 30s poll, so nothing is lost", () => {
        const step = defaultSeriesStep("2026-09-04T18:00:00.000Z", "2026-09-04T19:00:00.000Z");

        expect(step).toBeLessThan(30_000);
    });

    test("an unusable window asks for no downsampling rather than a bad step", () => {
        expect(defaultSeriesStep("nope", WINDOW.to)).toBeUndefined();
        expect(defaultSeriesStep(WINDOW.to, WINDOW.from)).toBeUndefined();
    });
});
