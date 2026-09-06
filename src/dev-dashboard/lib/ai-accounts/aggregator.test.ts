import { describe, expect, test } from "bun:test";
import {
    createScanCache,
    defaultSeriesStep,
    effectiveSpendGrain,
    transcriptScanKey,
} from "@app/dev-dashboard/lib/ai-accounts/aggregator";

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
describe("effectiveSpendGrain", () => {
    test("a single-source series keeps the grain it asked for", () => {
        expect(effectiveSpendGrain("calls", "minute")).toBe("minute");
        expect(effectiveSpendGrain("transcripts", "minute")).toBe("minute");
        expect(effectiveSpendGrain("calls", "day")).toBe("day");
    });

    test("both sources at minute grain draw on the hour, because the two halves must merge", () => {
        expect(effectiveSpendGrain("both", "minute")).toBe("hour");
    });

    test("both sources agree with the transcript half at every coarser grain", () => {
        expect(effectiveSpendGrain("both", "hour")).toBe("hour");
        expect(effectiveSpendGrain("both", "day")).toBe("day");
        expect(effectiveSpendGrain("both", "week")).toBe("week");
    });

    test("the merged grain is the one the transcript scan is keyed by, so the halves share buckets", () => {
        expect(transcriptScanKey({ ...WINDOW, source: "both" }, effectiveSpendGrain("both", "minute"))).toBe(
            transcriptScanKey({ ...WINDOW, source: "both" }, "minute")
        );
    });
});

/**
 * A month of transcripts takes about 20s and the TTL is 15s, so a TTL measured
 * from the LAUNCH expired the entry while its own worker was still running: the
 * next request evicted the promise it should have awaited and started a second
 * worker, and a request arriving just after the scan finished found the fresh
 * result already stale (eve review, PR #363). Time is injected, so nothing here
 * sleeps.
 */
describe("createScanCache", () => {
    function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: Error) => void } {
        let resolve!: (value: T) => void;
        let reject!: (err: Error) => void;
        const promise = new Promise<T>((res, rej) => {
            resolve = res;
            reject = rej;
        });

        return { promise, resolve, reject };
    }

    /** Let the microtask queue drain, so a settled promise's handlers have run. */
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    test("two callers arriving together share one run", () => {
        let runs = 0;
        const cache = createScanCache<string>(15_000, () => 0);
        const start = () => {
            runs += 1;
            return Promise.resolve("scan");
        };

        cache.share("k", start);
        cache.share("k", start);

        expect(runs).toBe(1);
    });

    test("a still-running scan is never evicted, however long it takes", async () => {
        let clock = 0;
        let runs = 0;
        const pending = deferred<string>();
        const cache = createScanCache<string>(15_000, () => clock);
        const start = () => {
            runs += 1;
            return pending.promise;
        };

        cache.share("k", start);
        // Well past the TTL, and past the ~20s a month-long scan takes.
        clock = 30_000;
        const second = cache.share("k", start);

        expect(runs).toBe(1);

        pending.resolve("scan");
        expect(await second).toBe("scan");
    });

    test("the TTL starts when the scan finishes, not when it was launched", async () => {
        let clock = 0;
        let runs = 0;
        const pending = deferred<string>();
        const cache = createScanCache<string>(15_000, () => clock);
        const start = () => {
            runs += 1;
            return runs === 1 ? pending.promise : Promise.resolve("second");
        };

        cache.share("k", start);
        clock = 20_000;
        pending.resolve("scan");
        await settle();

        // 10s after it FINISHED is still inside the TTL, even though the entry is
        // 30s old measured from its launch.
        clock = 30_000;
        expect(await cache.share("k", start)).toBe("scan");
        expect(runs).toBe(1);
    });

    test("a settled result does expire once the TTL has passed since completion", async () => {
        let clock = 0;
        let runs = 0;
        const cache = createScanCache<string>(15_000, () => clock);
        const start = () => {
            runs += 1;
            return Promise.resolve(`run-${runs}`);
        };

        expect(await cache.share("k", start)).toBe("run-1");
        await settle();

        clock = 20_000;
        expect(await cache.share("k", start)).toBe("run-2");
        expect(runs).toBe(2);
    });

    test("a failed scan is dropped, so the next caller retries", async () => {
        const clock = 0;
        let runs = 0;
        const cache = createScanCache<string>(15_000, () => clock);
        const start = () => {
            runs += 1;
            return runs === 1 ? Promise.reject(new Error("worker died")) : Promise.resolve("recovered");
        };

        await expect(cache.share("k", start)).rejects.toThrow("worker died");
        await settle();

        expect(await cache.share("k", start)).toBe("recovered");
        expect(runs).toBe(2);
    });

    test("a slow failure does not delete the replacement that took its key", async () => {
        const clock = 0;
        const first = deferred<string>();
        const cache = createScanCache<string>(15_000, () => clock);

        const failing = cache.share("k", () => first.promise);
        void failing.catch(() => {});

        // The first scan settles, ages out, and a replacement takes the key.
        first.reject(new Error("worker died"));
        await settle();

        const replacement = cache.share("k", () => Promise.resolve("replacement"));
        expect(await replacement).toBe("replacement");
        await settle();

        // The replacement is still the cached entry, not collateral of the failure.
        expect(cache.size()).toBe(1);
        expect(await cache.share("k", () => Promise.resolve("third"))).toBe("replacement");
    });

    test("different keys do not share a scan", () => {
        let runs = 0;
        const cache = createScanCache<string>(15_000, () => 0);
        const start = () => {
            runs += 1;
            return Promise.resolve("scan");
        };

        cache.share("a", start);
        cache.share("b", start);

        expect(runs).toBe(2);
        expect(cache.size()).toBe(2);
    });
});
