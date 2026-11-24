import { afterEach, beforeEach, describe, expect, it, jest, test } from "bun:test";
import { concurrentMap, debounce, KeyedRerun, rateLimitAwareDelay, retry, throttle, withTimeout } from "./async";

// Bun supports advanceTimersByTime at runtime but the type definitions are incomplete
declare module "bun:test" {
    namespace jest {
        function advanceTimersByTime(ms: number): void;
    }
}

describe("retry", () => {
    it("resolves on first try", async () => {
        expect(await retry(async () => "success")).toBe("success");
    });

    it("retries and succeeds on second attempt", async () => {
        let attempt = 0;
        const result = await retry(
            async () => {
                attempt++;

                if (attempt < 2) {
                    throw new Error("fail");
                }

                return "success";
            },
            { maxAttempts: 3, delay: 10 }
        );
        expect(result).toBe("success");
        expect(attempt).toBe(2);
    });

    it("rejects after exhausting all retries", async () => {
        let attempt = 0;
        await expect(
            retry(
                async () => {
                    attempt++;
                    throw new Error("always fails");
                },
                { maxAttempts: 3, delay: 10 }
            )
        ).rejects.toThrow("always fails");
        expect(attempt).toBe(3);
    });

    it("respects shouldRetry predicate", async () => {
        let attempt = 0;
        await expect(
            retry(
                async () => {
                    attempt++;
                    throw new Error("fatal");
                },
                {
                    maxAttempts: 5,
                    delay: 10,
                    shouldRetry: (err) => !(err instanceof Error && err.message === "fatal"),
                }
            )
        ).rejects.toThrow("fatal");
        expect(attempt).toBe(1);
    });

    it("calls onRetry callback", async () => {
        const retries: Array<{ attempt: number; delay: number }> = [];
        let attempt = 0;
        await retry(
            async () => {
                attempt++;

                if (attempt < 3) {
                    throw new Error("fail");
                }

                return "ok";
            },
            {
                maxAttempts: 3,
                delay: 10,
                backoff: "fixed",
                onRetry: (a, d) => retries.push({ attempt: a, delay: d }),
            }
        );
        expect(retries).toEqual([
            { attempt: 1, delay: 10 },
            { attempt: 2, delay: 10 },
        ]);
    });

    it("supports legacy number argument", async () => {
        let attempt = 0;
        await expect(
            retry(async () => {
                attempt++;
                throw new Error("fail");
            }, 2)
        ).rejects.toThrow("fail");
        expect(attempt).toBe(2);
    });

    describe("backoff strategies", () => {
        it("exponential: delay doubles each retry", async () => {
            const delays: number[] = [];
            let attempt = 0;
            await retry(
                async () => {
                    attempt++;

                    if (attempt < 4) {
                        throw new Error("fail");
                    }

                    return "ok";
                },
                { maxAttempts: 4, delay: 10, backoff: "exponential", onRetry: (_a, d) => delays.push(d) }
            );
            expect(delays).toEqual([10, 20, 40]);
        });

        it("linear: delay increases linearly", async () => {
            const delays: number[] = [];
            let attempt = 0;
            await retry(
                async () => {
                    attempt++;

                    if (attempt < 4) {
                        throw new Error("fail");
                    }

                    return "ok";
                },
                { maxAttempts: 4, delay: 10, backoff: "linear", onRetry: (_a, d) => delays.push(d) }
            );
            expect(delays).toEqual([10, 20, 30]);
        });

        it("fixed: delay stays constant", async () => {
            const delays: number[] = [];
            let attempt = 0;
            await retry(
                async () => {
                    attempt++;

                    if (attempt < 4) {
                        throw new Error("fail");
                    }

                    return "ok";
                },
                { maxAttempts: 4, delay: 10, backoff: "fixed", onRetry: (_a, d) => delays.push(d) }
            );
            expect(delays).toEqual([10, 10, 10]);
        });
    });
});

describe("debounce", () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    it("only fires after wait period", () => {
        let callCount = 0;
        const debounced = debounce(() => {
            callCount++;
        }, 100);
        debounced();
        expect(callCount).toBe(0);
        jest.advanceTimersByTime(100);
        expect(callCount).toBe(1);
    });

    it("resets timer on subsequent calls", () => {
        let callCount = 0;
        const debounced = debounce(() => {
            callCount++;
        }, 100);
        debounced();
        jest.advanceTimersByTime(50);
        debounced();
        jest.advanceTimersByTime(50);
        expect(callCount).toBe(0);
        jest.advanceTimersByTime(50);
        expect(callCount).toBe(1);
    });

    it("passes arguments to the original function", () => {
        let received: string[] = [];
        const debounced = debounce((...args: string[]) => {
            received = args;
        }, 100);
        debounced("a", "b");
        jest.advanceTimersByTime(100);
        expect(received).toEqual(["a", "b"]);
    });
});

describe("KeyedRerun", () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    /** Lets the promise callbacks queued by a finished call run. */
    const settle = async () => {
        for (let i = 0; i < 5; i++) {
            await Promise.resolve();
        }
    };

    /** A rerun whose calls wait for `finish()`; `calls` lists the key of each call as it starts. */
    function controlled(options: { callStarted?: boolean } = {}) {
        const calls: string[] = [];
        const pending: Array<{ started: () => void; finish: () => void }> = [];
        const rerun = new KeyedRerun<string>({
            run: (key, started) => {
                calls.push(key);
                if (options.callStarted !== false) {
                    started();
                }
                return new Promise<void>((resolve) => pending.push({ started, finish: resolve }));
            },
        });
        return { rerun, calls, pending };
    }

    it("runs once, the delay after the last trigger", () => {
        const { rerun, calls } = controlled();
        rerun.trigger("m1", 1000);
        jest.advanceTimersByTime(600);
        rerun.trigger("m1", 1000);
        jest.advanceTimersByTime(999);
        expect(calls).toEqual([]);
        jest.advanceTimersByTime(1);
        expect(calls).toEqual(["m1"]);
        expect(rerun.busy).toBe(true);
    });

    it("two triggers during a call give exactly one more call after it", async () => {
        const { rerun, calls, pending } = controlled();
        rerun.trigger("m1", 1000);
        jest.advanceTimersByTime(1000);
        rerun.trigger("m1", 1000);
        rerun.trigger("m1", 1000);
        jest.advanceTimersByTime(5000);
        expect(calls).toEqual(["m1"]);
        pending[0]!.finish();
        await settle();
        jest.advanceTimersByTime(1000);
        expect(calls).toEqual(["m1", "m1"]);
        pending[1]!.finish();
        await settle();
        jest.advanceTimersByTime(5000);
        expect(calls).toEqual(["m1", "m1"]);
        expect(rerun.busy).toBe(false);
    });

    it("a trigger before the call took its inputs is that call's, not a rerun", async () => {
        const { rerun, calls, pending } = controlled({ callStarted: false });
        rerun.trigger("m1", 1000);
        jest.advanceTimersByTime(1000);
        rerun.trigger("m1", 1000);
        pending[0]!.started();
        pending[0]!.finish();
        await settle();
        jest.advanceTimersByTime(5000);
        expect(calls).toEqual(["m1"]);
        expect(rerun.busy).toBe(false);
    });

    it("keys run independently, a failed call reaches onError, and stop cancels waiting calls", async () => {
        const errors: string[] = [];
        const calls: string[] = [];
        const rerun = new KeyedRerun<string>({
            run: async (key) => {
                calls.push(key);
                throw new Error(`${key} failed`);
            },
            onError: (_key, error) => errors.push(error instanceof Error ? error.message : String(error)),
        });
        rerun.trigger("m1", 100);
        rerun.trigger("m2", 300);
        jest.advanceTimersByTime(100);
        await settle();
        expect(calls).toEqual(["m1"]);
        expect(errors).toEqual(["m1 failed"]);
        rerun.stop();
        jest.advanceTimersByTime(1000);
        rerun.trigger("m3", 0);
        jest.advanceTimersByTime(1000);
        expect(calls).toEqual(["m1"]);
        expect(rerun.busy).toBe(false);
    });
});

describe("throttle", () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    it("fires immediately on first call", () => {
        let callCount = 0;
        const throttled = throttle(() => {
            callCount++;
        }, 100);
        throttled();
        expect(callCount).toBe(1);
    });

    it("blocks calls within the limit period", () => {
        let callCount = 0;
        const throttled = throttle(() => {
            callCount++;
        }, 100);
        throttled();
        throttled();
        throttled();
        expect(callCount).toBe(1);
    });

    it("allows calls again after limit period", () => {
        let callCount = 0;
        const throttled = throttle(() => {
            callCount++;
        }, 100);
        throttled();
        jest.advanceTimersByTime(100);
        throttled();
        expect(callCount).toBe(2);
    });
});

describe("withTimeout", () => {
    it("resolves when promise completes before timeout", async () => {
        expect(await withTimeout(Promise.resolve("done"), 1000)).toBe("done");
    });

    it("rejects with default error on timeout", async () => {
        const slow = new Promise<string>((r) => setTimeout(() => r("late"), 5000));
        await expect(withTimeout(slow, 10)).rejects.toThrow("Operation timed out after 10ms");
    });

    it("rejects with custom error on timeout", async () => {
        const slow = new Promise<string>((r) => setTimeout(() => r("late"), 5000));
        await expect(withTimeout(slow, 10, new Error("custom"))).rejects.toThrow("custom");
    });
});

describe("concurrentMap", () => {
    it("processes all items", async () => {
        const result = await concurrentMap({ items: [1, 2, 3], fn: async (n) => n * 2, concurrency: 2 });
        expect(result.get(1)).toBe(2);
        expect(result.get(2)).toBe(4);
        expect(result.get(3)).toBe(6);
    });

    it("respects concurrency limit", async () => {
        let maxConcurrent = 0;
        let current = 0;
        await concurrentMap({
            items: [1, 2, 3, 4, 5],
            fn: async (n) => {
                current++;
                if (current > maxConcurrent) {
                    maxConcurrent = current;
                }
                await new Promise((r) => setTimeout(r, 10));
                current--;
                return n;
            },
            concurrency: 2,
        });
        expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it("handles errors per item via onError", async () => {
        const errors: Array<{ item: number; error: unknown }> = [];
        const result = await concurrentMap({
            items: [1, 2, 3],
            fn: async (n) => {
                if (n === 2) {
                    throw new Error("fail");
                }

                return n * 10;
            },
            concurrency: 5,
            onError: (item, error) => errors.push({ item, error }),
        });
        expect(result.get(1)).toBe(10);
        expect(result.has(2)).toBe(false);
        expect(result.get(3)).toBe(30);
        expect(errors.length).toBe(1);
    });

    it("throws when concurrency < 1", async () => {
        await expect(concurrentMap({ items: [1], fn: async (n) => n, concurrency: 0 })).rejects.toThrow(
            "concurrency must be >= 1"
        );
    });
});

describe("retry with getDelay", () => {
    test("retries with custom getDelay", async () => {
        let attempt = 0;

        const result = await retry(
            async () => {
                attempt++;

                if (attempt < 3) {
                    throw new Error("transient");
                }

                return "success";
            },
            {
                maxAttempts: 5,
                getDelay: () => 10,
            }
        );

        expect(result).toBe("success");
        expect(attempt).toBe(3);
    });

    test("respects shouldRetry with getDelay", async () => {
        let attempt = 0;

        await expect(
            retry(
                async () => {
                    attempt++;
                    throw new Error("fatal");
                },
                {
                    maxAttempts: 5,
                    shouldRetry: () => false,
                    getDelay: () => 10,
                }
            )
        ).rejects.toThrow("fatal");

        expect(attempt).toBe(1);
    });
});

describe("rateLimitAwareDelay", () => {
    test("returns base exponential delay for normal errors", () => {
        const getDelay = rateLimitAwareDelay({ baseDelay: 100 });

        expect(getDelay(1, new Error("timeout"))).toBe(100);
        expect(getDelay(2, new Error("timeout"))).toBe(200);
        expect(getDelay(3, new Error("timeout"))).toBe(400);
    });

    test("returns at least rateLimitMinDelay for 429 errors", () => {
        const getDelay = rateLimitAwareDelay({
            baseDelay: 100,
            rateLimitMinDelay: 5000,
        });

        expect(getDelay(1, new Error("429 Too Many Requests"))).toBe(5000);
        expect(getDelay(2, new Error("429 Too Many Requests"))).toBe(5000);
        expect(getDelay(3, new Error("rate limit exceeded"))).toBe(5000);
    });

    test("detects quota and RESOURCE_EXHAUSTED errors", () => {
        const getDelay = rateLimitAwareDelay({ rateLimitMinDelay: 10000 });

        expect(getDelay(1, new Error("RESOURCE_EXHAUSTED"))).toBe(10000);
        expect(getDelay(1, new Error("quota exceeded"))).toBe(10000);
    });
});
