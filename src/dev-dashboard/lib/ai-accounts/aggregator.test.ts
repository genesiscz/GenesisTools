import { describe, expect, test } from "bun:test";
import type { SpendSeriesPoint } from "@app/dev-dashboard/contract/ai-accounts";
import {
    createScanCache,
    defaultSeriesStep,
    effectiveSpendGrain,
    foldSpendPoints,
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
        expect(transcriptScanKey(WINDOW)).toBe(transcriptScanKey({ ...WINDOW }));
    });

    /**
     * The grain used to be in the key while totals asked for `day` and the series
     * asked for whatever the window wanted, so the 1h, 6h and 24h presets ran two
     * workers over the same transcripts and only the 7d and 30d presets shared one
     * (eve review, PR #363).
     */
    test("the key names no grain, so every caller over one window lands on one scan", () => {
        const key = transcriptScanKey(WINDOW);

        for (const grain of ["minute", "hour", "day", "week"]) {
            expect(key).not.toContain(grain);
        }

        // The two doors build their query objects separately; only the window and
        // the account filter may reach the key.
        expect(transcriptScanKey({ from: WINDOW.from, to: WINDOW.to, source: "both" })).toBe(key);
        expect(transcriptScanKey({ from: WINDOW.from, to: WINDOW.to, source: "calls" })).toBe(key);
    });

    test("a different window is a different scan", () => {
        expect(transcriptScanKey(WINDOW)).not.toBe(transcriptScanKey({ ...WINDOW, to: "2026-09-04T20:00:00.000Z" }));
    });

    test("the account filter is part of the key, and its order is not", () => {
        const a = transcriptScanKey({ ...WINDOW, accounts: ["acc_work", "acc_shop"] });
        const b = transcriptScanKey({ ...WINDOW, accounts: ["acc_shop", "acc_work"] });

        expect(a).toBe(b);
        expect(a).not.toBe(transcriptScanKey(WINDOW));
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

    test("the merged grain is what the transcript half is folded onto, so the halves share buckets", () => {
        const hourly = [
            { t: "2026-09-04T09", costUsd: 1, tokens: 10, byAccount: { acc_work: { costUsd: 1, tokens: 10 } } },
            { t: "2026-09-04T10", costUsd: 2, tokens: 20, byAccount: { acc_work: { costUsd: 2, tokens: 20 } } },
        ];
        const merged = effectiveSpendGrain("both", "minute");

        expect(foldSpendPoints(hourly, merged).map((p) => p.t)).toEqual(["2026-09-04T09", "2026-09-04T10"]);
    });
});

/**
 * Every scan now runs at hour grain and each caller folds it onto its own axis,
 * so one worker answers totals and the series whatever the series asked for
 * (eve review, PR #363).
 */
describe("foldSpendPoints", () => {
    const HOURS: SpendSeriesPoint[] = [
        {
            t: "2026-09-03T23",
            costUsd: 1,
            tokens: 10,
            byAccount: { acc_work: { costUsd: 1, tokens: 10 } },
            byModel: { "gpt-5.6": { costUsd: 1, tokens: 10 } },
        },
        {
            t: "2026-09-04T09",
            costUsd: 2,
            tokens: 20,
            byAccount: { acc_work: { costUsd: 2, tokens: 20 } },
            byModel: { "gpt-5.6": { costUsd: 2, tokens: 20 } },
        },
        {
            t: "2026-09-04T10",
            costUsd: 4,
            tokens: 40,
            byAccount: { acc_shop: { costUsd: 4, tokens: 40 } },
            byModel: { "claude-opus-5": { costUsd: 4, tokens: 40 } },
        },
    ];

    test("hour is already the scan's own axis, so nothing moves", () => {
        expect(foldSpendPoints(HOURS, "hour").map((p) => p.t)).toEqual([
            "2026-09-03T23",
            "2026-09-04T09",
            "2026-09-04T10",
        ]);
    });

    test("a minute request still gets hour buckets, because transcripts cannot answer finer", () => {
        expect(foldSpendPoints(HOURS, "minute")).toEqual(foldSpendPoints(HOURS, "hour"));
    });

    test("day folds the hours of one local day together", () => {
        const days = foldSpendPoints(HOURS, "day");

        expect(days.map((p) => p.t)).toEqual(["2026-09-03", "2026-09-04"]);
        expect(days[1].costUsd).toBe(6);
        expect(days[1].tokens).toBe(60);
        expect(days[1].byAccount).toEqual({
            acc_work: { costUsd: 2, tokens: 20 },
            acc_shop: { costUsd: 4, tokens: 40 },
        });
        expect(days[1].byModel).toEqual({
            "gpt-5.6": { costUsd: 2, tokens: 20 },
            "claude-opus-5": { costUsd: 4, tokens: 40 },
        });
    });

    test("week folds every day onto its Monday, so all three land in one bucket", () => {
        const weeks = foldSpendPoints(HOURS, "week");

        // 2026-09-03 and 2026-09-04 share a week, whichever Monday the rule names.
        expect(weeks).toHaveLength(1);
        expect(weeks[0].costUsd).toBe(7);
        expect(weeks[0].tokens).toBe(70);
    });

    test("folding conserves the total at every grain", () => {
        const total = HOURS.reduce((sum, p) => sum + p.costUsd, 0);

        for (const grain of ["minute", "hour", "day", "week"] as const) {
            expect(foldSpendPoints(HOURS, grain).reduce((sum, p) => sum + p.costUsd, 0)).toBe(total);
        }
    });

    test("the caller's points are not mutated", () => {
        foldSpendPoints(HOURS, "day");

        expect(HOURS[1].byAccount).toEqual({ acc_work: { costUsd: 2, tokens: 20 } });
        expect(HOURS[1].costUsd).toBe(2);
    });

    // The fixture above spreads different accounts over the folded day, which a
    // shallow copy survives. The SAME account in two hours is what shared the
    // bucket objects with the cached scan (eve review, PR #363 t3).
    test("the same account in two hours of one day leaves the cached hour buckets untouched across repeated folds", () => {
        const hours: SpendSeriesPoint[] = [
            {
                t: "2026-09-04T09",
                costUsd: 1,
                tokens: 10,
                byAccount: { acc_work: { costUsd: 1, tokens: 10 } },
                byModel: { "gpt-5.6": { costUsd: 1, tokens: 10 } },
            },
            {
                t: "2026-09-04T10",
                costUsd: 2,
                tokens: 20,
                byAccount: { acc_work: { costUsd: 2, tokens: 20 } },
                byModel: { "gpt-5.6": { costUsd: 2, tokens: 20 } },
            },
        ];

        const first = foldSpendPoints(hours, "day");
        const second = foldSpendPoints(hours, "day");

        expect(hours[0].byAccount).toEqual({ acc_work: { costUsd: 1, tokens: 10 } });
        expect(hours[0].byModel).toEqual({ "gpt-5.6": { costUsd: 1, tokens: 10 } });
        expect(first[0].byAccount).toEqual({ acc_work: { costUsd: 3, tokens: 30 } });
        expect(second[0].byAccount).toEqual({ acc_work: { costUsd: 3, tokens: 30 } });
        expect(second[0].byModel).toEqual({ "gpt-5.6": { costUsd: 3, tokens: 30 } });
    });

    test("a key the scan could not have produced is passed through rather than dropped", () => {
        const odd: SpendSeriesPoint[] = [{ t: "nope", costUsd: 3, tokens: 1, byAccount: {} }];

        expect(foldSpendPoints(odd, "day")).toEqual(odd);
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
