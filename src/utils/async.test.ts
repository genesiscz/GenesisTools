import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { concurrentMap, debounce, retry, throttle, withTimeout } from "./async";

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
