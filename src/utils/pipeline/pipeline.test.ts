import { describe, expect, test } from "bun:test";
import { batchStream, hedge, mapStream, pipeline } from "./pipeline";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function* slowSource(count: number, gapMs: number): AsyncGenerator<number> {
    for (let i = 0; i < count; i++) {
        await sleep(gapMs);
        yield i;
    }
}

describe("pipeline", () => {
    test("stage 2 starts before stage 1 finishes every item", async () => {
        const events: string[] = [];

        await pipeline([1, 2, 3, 4])
            .map(
                "one",
                async (n) => {
                    await sleep(n === 1 ? 5 : 60);
                    events.push(`one:${n}`);
                    return n;
                },
                { concurrency: 4 }
            )
            .map(
                "two",
                async (n) => {
                    events.push(`two:${n}`);
                    return n;
                },
                { concurrency: 4 }
            )
            .collect();

        // With a barrier, every one:* would precede every two:*.
        expect(events.indexOf("two:1")).toBeLessThan(events.indexOf("one:2"));
    });

    test("fan-out and drop", async () => {
        const out = await pipeline([1, 2, 3])
            .map("expand", (n) => (n === 2 ? undefined : [n, n * 10]))
            .collect();

        expect(out.sort((a, b) => a - b)).toEqual([1, 3, 10, 30]);
    });

    test("respects per-stage concurrency", async () => {
        let inflight = 0;
        let peak = 0;

        await pipeline([1, 2, 3, 4, 5, 6, 7, 8])
            .map(
                "limited",
                async (n) => {
                    inflight++;
                    peak = Math.max(peak, inflight);
                    await sleep(10);
                    inflight--;
                    return n;
                },
                { concurrency: 3 }
            )
            .collect();

        expect(peak).toBe(3);
    });

    test("onError drops the item and keeps the stream alive", async () => {
        const errors: unknown[] = [];
        const out = await pipeline([1, 2, 3])
            .map(
                "boom",
                (n) => {
                    if (n === 2) {
                        throw new Error("nope");
                    }

                    return n;
                },
                { onError: (err) => errors.push(err) }
            )
            .collect();

        expect(out.sort()).toEqual([1, 3]);
        expect(errors).toHaveLength(1);
    });

    test("a stage that throws undefined is still a failure, not an empty result", async () => {
        const errors: unknown[] = [];
        const out = await pipeline([1, 2, 3])
            .map(
                "boom",
                (n) => {
                    if (n === 2) {
                        throw undefined;
                    }

                    return n;
                },
                { onError: (err) => errors.push(err) }
            )
            .collect();

        expect(out.sort()).toEqual([1, 3]);
        expect(errors).toEqual([undefined]);
    });

    test("without onError the error propagates", async () => {
        const run = pipeline([1]).map("boom", () => {
            throw new Error("nope");
        });

        expect(run.collect()).rejects.toThrow("nope");
    });

    test("batch groups by size and flushes the remainder", async () => {
        const batches = await pipeline([1, 2, 3, 4, 5]).batch("b", { size: 2 }).collect();
        expect(batches).toEqual([[1, 2], [3, 4], [5]]);
    });

    test("batch flushes a partial batch on maxWaitMs", async () => {
        const batches: number[][] = [];
        for await (const batch of batchStream(slowSource(3, 40), { size: 10, maxWaitMs: 10 })) {
            batches.push(batch);
        }

        expect(batches.length).toBeGreaterThan(1);
        expect(batches.flat()).toEqual([0, 1, 2]);
    });

    test("mapStream yields in completion order, not input order", async () => {
        const out: number[] = [];
        for await (const n of mapStream(
            (async function* () {
                yield 50;
                yield 5;
            })(),
            async (ms: number) => {
                await sleep(ms);
                return ms;
            },
            { concurrency: 2 }
        )) {
            out.push(n);
        }

        expect(out).toEqual([5, 50]);
    });
    test("hedge starts a second attempt and keeps the faster one", async () => {
        let attempt = 0;
        const started = Date.now();

        const value = await hedge(async () => {
            attempt++;
            // first attempt stalls, the hedged attempt is quick
            await sleep(attempt === 1 ? 400 : 10);
            return attempt;
        }, 30);

        expect(value).toBe(2);
        expect(Date.now() - started).toBeLessThan(300);
    });

    test("hedge does not fire when the first attempt is fast", async () => {
        let attempts = 0;
        const value = await hedge(async () => {
            attempts++;
            await sleep(5);
            return "ok";
        }, 200);

        expect(value).toBe("ok");
        expect(attempts).toBe(1);
    });

    test("hedge rejects only when every attempt fails", async () => {
        const run = hedge(async () => {
            await sleep(20);
            throw new Error("both failed");
        }, 5);

        expect(run).rejects.toThrow("both failed");
    });

    test("map stage hedges stragglers", async () => {
        const calls = new Map<number, number>();
        const hedged: unknown[] = [];

        const out = await pipeline([1, 2])
            .map(
                "slow",
                async (n) => {
                    const seen = (calls.get(n) ?? 0) + 1;
                    calls.set(n, seen);
                    // item 1 is slow on its first attempt only
                    await sleep(n === 1 && seen === 1 ? 300 : 10);
                    return n;
                },
                { concurrency: 2, hedgeAfterMs: 40, onHedge: (item) => hedged.push(item) }
            )
            .collect();

        expect(out.sort()).toEqual([1, 2]);
        expect(hedged).toEqual([1]);
        expect(calls.get(1)).toBe(2);
    });
});
