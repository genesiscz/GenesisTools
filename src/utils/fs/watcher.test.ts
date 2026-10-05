import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { skip } from "@genesiscz/utils/test/skip";
import type { Event } from "@parcel/watcher";
import { watchFileFeed } from "./file-feed-watcher";
import {
    createWatcher,
    isTransientError,
    type WatcherEvent,
    type WatcherOptions,
    type WatcherSubscription,
    waitForPath,
    watchPath,
} from "./watcher";

let tempDir: string;
let sub: WatcherSubscription | null = null;

beforeEach(() => {
    // Use realpathSync to resolve macOS /var -> /private/var symlink
    // so that paths match what @parcel/watcher reports
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "watcher-test-")));
});

afterEach(async () => {
    if (sub?.active) {
        await sub.unsubscribe();
    }

    sub = null;

    try {
        rmSync(tempDir, { recursive: true, force: true });
    } catch {
        // best effort
    }
});

/**
 * A stand-in for @parcel/watcher: `emit` delivers native events at once. createWatcher's own logic
 * (type mapping, debounce, filter, unsubscribe) is tested on it. Real FSEvents delivery took seconds
 * under load, so the tests that waited on it were slow and failed 2-3 times even alone (2026-10-04).
 */
function fakeSource() {
    let deliver: ((err: Error | null, events: Event[]) => void) | null = null;
    let unsubscribed = 0;
    const subscribe: NonNullable<WatcherOptions["subscribe"]> = async (_dir, callback) => {
        deliver = callback;
        return {
            unsubscribe: async () => {
                unsubscribed++;
            },
        };
    };

    return {
        subscribe,
        emit: (events: Event[]) => deliver?.(null, events),
        fail: (err: Error) => deliver?.(err, []),
        unsubscribed: () => unsubscribed,
    };
}

/** Every batch the watcher hands its callback, and a promise for the first `count` of them. */
function batchesOf() {
    const batches: WatcherEvent[][] = [];
    const waiters: Array<{ count: number; resolve: () => void }> = [];

    const until = (count: number, timeoutMs = 5_000): Promise<void> => {
        if (batches.length >= count) {
            return Promise.resolve();
        }

        return new Promise<void>((resolve, reject) => {
            const waiter = {
                count,
                resolve: () => {
                    clearTimeout(timer);
                    resolve();
                },
            };
            const timer = setTimeout(() => {
                waiters.splice(waiters.indexOf(waiter), 1);
                reject(new Error(`waited ${timeoutMs} ms for batch ${count}, saw ${batches.length}`));
            }, timeoutMs);

            waiters.push(waiter);
        });
    };

    return {
        batches,
        callback: (batch: WatcherEvent[]) => {
            batches.push(batch);
            for (const waiter of waiters.filter((w) => batches.length >= w.count)) {
                waiter.resolve();
            }
        },
        until,
    };
}

describe("createWatcher", () => {
    test("maps native create, update and delete events into one debounced batch", async () => {
        const source = fakeSource();
        const seen = batchesOf();
        sub = await createWatcher(tempDir, seen.callback, { debounceMs: 20, subscribe: source.subscribe });

        source.emit([
            { type: "create", path: "/x/a.txt" },
            { type: "update", path: "/x/b.txt" },
            { type: "delete", path: "/x/c.txt" },
        ]);
        await seen.until(1);

        expect(seen.batches).toEqual([
            [
                { type: "create", path: "/x/a.txt" },
                { type: "update", path: "/x/b.txt" },
                { type: "delete", path: "/x/c.txt" },
            ],
        ]);
    });

    test("debounces rapid changes into a single callback, the latest type per path winning", async () => {
        const source = fakeSource();
        const seen = batchesOf();
        sub = await createWatcher(tempDir, seen.callback, { debounceMs: 40, subscribe: source.subscribe });

        for (let i = 0; i < 5; i++) {
            source.emit([{ type: "create", path: `/x/rapid-${i}.txt` }]);
        }
        source.emit([{ type: "update", path: "/x/rapid-0.txt" }]);
        await seen.until(1);
        // A second batch would need another debounce window; give it one.
        await Bun.sleep(80);

        expect(seen.batches).toHaveLength(1);
        expect(seen.batches[0]).toHaveLength(5);
        expect(seen.batches[0]?.find((event) => event.path === "/x/rapid-0.txt")?.type).toBe("update");
    });

    test("applies the filter before an event is queued", async () => {
        const source = fakeSource();
        const seen = batchesOf();
        sub = await createWatcher(tempDir, seen.callback, {
            debounceMs: 20,
            subscribe: source.subscribe,
            filter: (event) => !event.path.endsWith(".tmp"),
        });

        source.emit([
            { type: "create", path: "/x/ignored.tmp" },
            { type: "create", path: "/x/kept.txt" },
        ]);
        await seen.until(1);

        expect(seen.batches).toEqual([[{ type: "create", path: "/x/kept.txt" }]]);
    });

    test("unsubscribe stops delivery, drops a pending batch and releases the native subscription once", async () => {
        const source = fakeSource();
        const seen = batchesOf();
        sub = await createWatcher(tempDir, seen.callback, { debounceMs: 20, subscribe: source.subscribe });

        source.emit([{ type: "create", path: "/x/pending.txt" }]);
        await sub.unsubscribe();
        await sub.unsubscribe();
        source.emit([{ type: "create", path: "/x/after-unsub.txt" }]);
        await Bun.sleep(60);

        expect(sub.active).toBe(false);
        expect(seen.batches).toEqual([]);
        expect(source.unsubscribed()).toBe(1);
    });

    test("reports active state correctly", async () => {
        const source = fakeSource();
        sub = await createWatcher(tempDir, () => {}, { subscribe: source.subscribe });
        expect(sub.active).toBe(true);

        await sub.unsubscribe();
        expect(sub.active).toBe(false);
    });

    test("trips its circuit breaker after maxErrors native errors in a row", async () => {
        const source = fakeSource();
        sub = await createWatcher(tempDir, () => {}, { maxErrors: 3, subscribe: source.subscribe });

        source.fail(new Error("one"));
        source.fail(new Error("two"));
        expect(sub.active).toBe(true);
        source.fail(new Error("three"));

        expect(sub.active).toBe(false);
        expect(source.unsubscribed()).toBe(1);
    });

    test("an error delivered while subscribing trips the breaker as soon as the subscription exists", async () => {
        let unsubscribed = 0;
        const subscribe: NonNullable<WatcherOptions["subscribe"]> = async (_dir, callback) => {
            callback(new Error("failed while subscribing"), []);

            return {
                unsubscribe: async () => {
                    unsubscribed++;
                },
            };
        };

        sub = await createWatcher(tempDir, () => {}, { maxErrors: 1, subscribe });

        expect(sub.active).toBe(false);
        expect(unsubscribed).toBe(1);
    });

    // The one test on real FSEvents: the native addon reports what happens on disk. A probe file is
    // written until the stream delivers, so the scenario never races the stream's start.
    test.skipIf(skip.onWindows)(
        "sees a real file created, modified and deleted through @parcel/watcher",
        async () => {
            const events: WatcherEvent[] = [];
            let wake: () => void = () => {};
            sub = await createWatcher(
                tempDir,
                (batch) => {
                    events.push(...batch);
                    wake();
                },
                { debounceMs: 50 }
            );
            const waitFor = async (match: () => boolean, what: string) => {
                const deadline = Date.now() + 20_000;
                while (!match()) {
                    if (Date.now() > deadline) {
                        throw new Error(`no ${what} event within 20 s; saw ${SafeJSON.stringify(events)}`);
                    }
                    await new Promise<void>((resolve) => {
                        wake = resolve;
                        setTimeout(resolve, 250);
                    });
                }
            };

            for (let i = 0; !events.some((event) => event.path.includes("__probe")); i++) {
                if (i > 80) {
                    throw new Error("the watcher delivered nothing within 20 s");
                }

                await Bun.write(join(tempDir, `__probe-${i}`), String(i));
                // Up to 250 ms for this probe's batch before the next probe.
                await new Promise<void>((resolve) => {
                    wake = resolve;
                    setTimeout(resolve, 250);
                });
            }

            const filePath = join(tempDir, "real.txt");
            await Bun.write(filePath, "one");
            await waitFor(() => events.some((e) => e.path === filePath), "create");
            await Bun.write(filePath, "two, longer");
            await waitFor(() => events.some((e) => e.path === filePath && e.type === "update"), "update");
            rmSync(filePath);
            await waitFor(() => events.some((e) => e.path === filePath && e.type === "delete"), "delete");

            expect(events.some((e) => e.path === filePath && e.type === "delete")).toBe(true);
        },
        { timeout: 70_000 }
    );
});

describe("isTransientError", () => {
    test("returns true for ECONNREFUSED error code", () => {
        const err = new Error("Connection refused");
        (err as NodeJS.ErrnoException).code = "ECONNREFUSED";
        expect(isTransientError(err)).toBe(true);
    });

    test("returns true for ECONNRESET error code", () => {
        const err = new Error("Connection reset");
        (err as NodeJS.ErrnoException).code = "ECONNRESET";
        expect(isTransientError(err)).toBe(true);
    });

    test("returns true for ENOTFOUND error code", () => {
        const err = new Error("DNS lookup failed");
        (err as NodeJS.ErrnoException).code = "ENOTFOUND";
        expect(isTransientError(err)).toBe(true);
    });

    test("returns true for ETIMEDOUT error code", () => {
        const err = new Error("Connection timed out");
        (err as NodeJS.ErrnoException).code = "ETIMEDOUT";
        expect(isTransientError(err)).toBe(true);
    });

    test("returns true for EPIPE error code", () => {
        const err = new Error("Broken pipe");
        (err as NodeJS.ErrnoException).code = "EPIPE";
        expect(isTransientError(err)).toBe(true);
    });

    test("returns true for EAI_AGAIN error code", () => {
        const err = new Error("Temporary DNS failure");
        (err as NodeJS.ErrnoException).code = "EAI_AGAIN";
        expect(isTransientError(err)).toBe(true);
    });

    test("returns true for 'connection reset' in message", () => {
        expect(isTransientError(new Error("The connection reset unexpectedly"))).toBe(true);
    });

    test("returns true for 'timeout' in message", () => {
        expect(isTransientError(new Error("Request timeout after 30s"))).toBe(true);
    });

    test("returns true for 'socket hang up' in message", () => {
        expect(isTransientError(new Error("socket hang up"))).toBe(true);
    });

    test("returns true for 'dns' in message", () => {
        expect(isTransientError(new Error("DNS resolution failed"))).toBe(true);
    });

    test("returns true for 'network' in message", () => {
        expect(isTransientError(new Error("Network error occurred"))).toBe(true);
    });

    test("returns true for 'econnrefused' in message (lowercase match)", () => {
        expect(isTransientError(new Error("connect ECONNREFUSED 127.0.0.1:6333"))).toBe(true);
    });

    test("returns false for TypeError", () => {
        expect(isTransientError(new TypeError("Cannot read property 'x'"))).toBe(false);
    });

    test("returns false for generic Error without network keywords", () => {
        expect(isTransientError(new Error("Invalid argument"))).toBe(false);
    });

    test("returns false for SyntaxError", () => {
        expect(isTransientError(new SyntaxError("Unexpected token"))).toBe(false);
    });

    test("returns false for non-Error values (string)", () => {
        expect(isTransientError("some error string")).toBe(false);
    });

    test("returns false for non-Error values (number)", () => {
        expect(isTransientError(42)).toBe(false);
    });

    test("returns false for null", () => {
        expect(isTransientError(null)).toBe(false);
    });

    test("returns false for undefined", () => {
        expect(isTransientError(undefined)).toBe(false);
    });
});

describe("watchPath / waitForPath", () => {
    /** The notification reply writer's shape: write a temp file, then rename it into place. */
    function atomicWrite(target: string, content: string): void {
        const tmp = `${target}.${Math.random().toString(36).slice(2)}.tmp`;
        writeFileSync(tmp, content);
        renameSync(tmp, target);
    }

    test(
        "sees a file that does not exist yet land by atomic rename, twice, then an in-place write",
        async () => {
            const target = join(tempDir, "reply.json");
            const seen: WatcherEvent[] = [];
            let expected = 0;
            let notify: (() => void) | null = null;
            const next = () =>
                new Promise<void>((resolve, reject) => {
                    expected = seen.length + 1;
                    notify = resolve;
                    // A deadline, not a delay: generous because fs.watch delivery slows under the parallel run.
                    setTimeout(() => reject(new Error(`no event; saw ${SafeJSON.stringify(seen)}`)), 15_000);
                });

            sub = watchPath(target, (events) => {
                seen.push(...events);

                if (seen.length >= expected && notify) {
                    notify();
                    notify = null;
                }
            });

            await Bun.sleep(50);
            let pending = next();
            atomicWrite(target, "1");
            await pending;
            expect(seen[seen.length - 1]).toEqual({ type: "create", path: target });

            // The inode changes on every rename; a file-bound watcher goes deaf here, this one must not.
            pending = next();
            atomicWrite(target, "2");
            await pending;
            expect(seen[seen.length - 1].path).toBe(target);
            expect(seen[seen.length - 1].type).not.toBe("delete");

            pending = next();
            writeFileSync(target, "3");
            await pending;
            expect(seen.every((event) => event.path === target)).toBe(true);
            expect(seen.some((event) => event.type === "update" || event.type === "create")).toBe(true);
        },
        { timeout: 50_000 }
    );

    test(
        "ignores sibling files and reports a delete",
        async () => {
            const target = join(tempDir, "only-me.txt");
            writeFileSync(target, "x");
            const seen: WatcherEvent[] = [];
            let notify: (() => void) | null = null;
            const gone = new Promise<void>((resolve) => {
                notify = resolve;
            });

            sub = watchPath(target, (events) => {
                seen.push(...events);

                if (events.some((event) => event.type === "delete") && notify) {
                    notify();
                }
            });

            await Bun.sleep(50);
            writeFileSync(join(tempDir, "sibling.txt"), "noise");
            await Bun.sleep(100);
            // FSEvents may still deliver the pre-arm write of `target` itself; what must never
            // arrive is anything about the sibling.
            expect(seen.every((event) => event.path === target)).toBe(true);
            rmSync(target);
            await gone;
            expect(seen[seen.length - 1]).toEqual({ type: "delete", path: target });
        },
        { timeout: 20_000 }
    );

    test("waitForPath resolves at once for an existing file, true on arrival, false on timeout or abort", async () => {
        const existing = join(tempDir, "here.txt");
        writeFileSync(existing, "x");
        expect(await waitForPath(existing, { timeoutMs: 10 })).toBe(true);

        const nestedDir = join(tempDir, "nested");
        mkdirSync(nestedDir);
        const later = join(nestedDir, "later.txt");
        const arrival = waitForPath(later, { timeoutMs: 5000 });
        await Bun.sleep(50);
        atomicWrite(later, "landed");
        expect(await arrival).toBe(true);

        expect(await waitForPath(join(tempDir, "never.txt"), { timeoutMs: 30 })).toBe(false);

        const controller = new AbortController();
        const aborted = waitForPath(join(tempDir, "never2.txt"), { signal: controller.signal });
        controller.abort();
        expect(await aborted).toBe(false);
    });

    test("waitForPath still sees the file when the directory watch is deaf, through its fallback poll", async () => {
        // bun 1.3.13 on darwin: after the first FSWatcher.close() in a process, every fs.watch created
        // afterwards delivers at most one event (measured 10/10 before any close, 1/10 after). That is
        // what the codex daemon does once per control request, so without the poll its second wait
        // sat out the whole timeout. The throwaway watcher below puts this process into that state
        // where the defect exists; where it does not, the watch answers first and the test still holds.
        const throwaway = watch(tempDir, () => {});
        throwaway.close();

        const deafDir = join(tempDir, "deaf");
        mkdirSync(deafDir);
        const target = join(deafDir, "reply.json");
        const startedAt = performance.now();
        const arrival = waitForPath(target, { timeoutMs: 4000, pollMs: 40 });
        await Bun.sleep(30);
        atomicWrite(target, "landed");

        expect(await arrival).toBe(true);
        expect(performance.now() - startedAt).toBeLessThan(2000);
    });

    test("watchPath throws when the parent directory does not exist", () => {
        expect(() => watchPath(join(tempDir, "missing", "x.txt"), () => {})).toThrow(
            /watchPath: parent directory does not exist/
        );
    });
});

describe("watchFileFeed", () => {
    test(
        "still sees a file created after fs.watch has already been closed once in this process",
        async () => {
            const path = join(tempDir, "reply.json");
            const deaf = watch(tempDir);
            deaf.close();

            void Bun.sleep(200).then(() => Bun.write(path, '{"ok":true}'));

            const started = Date.now();
            await watchFileFeed({
                path,
                deadlineAt: Date.now() + 2_000,
                debounceMs: 0,
                pollFallbackMs: 100,
                onChange: () => (existsSync(path) ? { done: true } : undefined),
            });

            expect(existsSync(path)).toBe(true);
            expect(Date.now() - started).toBeLessThan(1_500);
        },
        { timeout: 15_000 }
    );
});
