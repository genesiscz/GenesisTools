import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWatcher, isTransientError, type WatcherEvent, type WatcherSubscription } from "./watcher";

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

/** Helper: wait for callback to fire and collect events */
function collectEvents(opts?: { debounceMs?: number; filter?: (e: WatcherEvent) => boolean }): {
    events: WatcherEvent[];
    waitForEvents: (minCount?: number, timeoutMs?: number) => Promise<WatcherEvent[]>;
    startWatcher: () => Promise<void>;
} {
    const events: WatcherEvent[] = [];
    let resolve: ((events: WatcherEvent[]) => void) | null = null;
    let minExpected = 1;

    const waitForEvents = (minCount = 1, timeoutMs = 8000): Promise<WatcherEvent[]> => {
        minExpected = minCount;

        if (events.length >= minExpected) {
            return Promise.resolve(events);
        }

        return new Promise<WatcherEvent[]>((res, rej) => {
            resolve = res;
            const timer = setTimeout(() => {
                rej(new Error(`Timed out waiting for ${minCount} events, got ${events.length}`));
            }, timeoutMs);

            // Clean up timer when resolved
            const originalResolve = resolve;
            resolve = (evts) => {
                clearTimeout(timer);
                originalResolve(evts);
            };
        });
    };

    const startWatcher = async () => {
        sub = await createWatcher(
            tempDir,
            (batch) => {
                events.push(...batch);

                if (resolve && events.length >= minExpected) {
                    resolve(events);
                    resolve = null;
                }
            },
            {
                debounceMs: opts?.debounceMs ?? 300,
                filter: opts?.filter,
            }
        );
    };

    return { events, waitForEvents, startWatcher };
}

describe("createWatcher", () => {
    test("detects file creation", async () => {
        const { waitForEvents, startWatcher } = collectEvents();
        await startWatcher();

        // Small delay to ensure watcher is fully subscribed
        await Bun.sleep(100);

        const filePath = join(tempDir, "new-file.txt");
        await Bun.write(filePath, "hello world");

        const events = await waitForEvents(1);
        const createEvent = events.find((e) => e.path === filePath && e.type === "create");
        expect(createEvent).toBeTruthy();
    });

    test("detects file modification", async () => {
        // Create file first before starting watcher
        const filePath = join(tempDir, "existing.txt");
        await Bun.write(filePath, "original");

        const { waitForEvents, startWatcher } = collectEvents();
        await startWatcher();
        await Bun.sleep(100);

        await Bun.write(filePath, "modified content");

        const events = await waitForEvents(1);
        const updateEvent = events.find((e) => e.path === filePath && e.type === "update");
        expect(updateEvent).toBeTruthy();
    });

    test("detects file deletion", async () => {
        const filePath = join(tempDir, "to-delete.txt");
        await Bun.write(filePath, "temporary");

        const { waitForEvents, startWatcher } = collectEvents();
        await startWatcher();
        await Bun.sleep(100);

        rmSync(filePath);

        const events = await waitForEvents(1);
        const deleteEvent = events.find((e) => e.path === filePath && e.type === "delete");
        expect(deleteEvent).toBeTruthy();
    });

    test("debounces rapid changes into a single callback", async () => {
        let callbackCount = 0;
        const allEvents: WatcherEvent[] = [];

        sub = await createWatcher(
            tempDir,
            (batch) => {
                callbackCount++;
                allEvents.push(...batch);
            },
            { debounceMs: 500 }
        );

        await Bun.sleep(100);

        // Write 5 files in rapid succession
        for (let i = 0; i < 5; i++) {
            await Bun.write(join(tempDir, `rapid-${i}.txt`), `content-${i}`);
        }

        // Wait for debounce + processing
        await Bun.sleep(1500);

        // Should have fired once (or at most twice due to timing) with all events
        expect(callbackCount).toBeLessThanOrEqual(2);
        expect(allEvents.length).toBeGreaterThanOrEqual(5);
    });

    test("applies filter to reject events", async () => {
        const { events, startWatcher } = collectEvents({
            filter: (event) => !event.path.endsWith(".tmp"),
        });
        await startWatcher();
        await Bun.sleep(100);

        // Write a .tmp file (should be filtered out)
        await Bun.write(join(tempDir, "ignored.tmp"), "temp");

        // Write a .txt file (should pass)
        await Bun.write(join(tempDir, "kept.txt"), "kept");

        await Bun.sleep(1000);

        const tmpEvents = events.filter((e) => e.path.endsWith(".tmp"));
        expect(tmpEvents.length).toBe(0);

        const txtEvents = events.filter((e) => e.path.endsWith(".txt"));
        expect(txtEvents.length).toBeGreaterThanOrEqual(1);
    });

    test("unsubscribe stops receiving events", async () => {
        const { events, startWatcher } = collectEvents();
        await startWatcher();
        await Bun.sleep(100);

        await sub!.unsubscribe();
        expect(sub!.active).toBe(false);

        // Write a file after unsubscribe
        await Bun.write(join(tempDir, "after-unsub.txt"), "should not be seen");
        await Bun.sleep(800);

        const postUnsub = events.filter((e) => e.path.includes("after-unsub"));
        expect(postUnsub.length).toBe(0);
    });

    test("reports active state correctly", async () => {
        const { startWatcher } = collectEvents();
        await startWatcher();

        expect(sub!.active).toBe(true);

        await sub!.unsubscribe();
        expect(sub!.active).toBe(false);
    });
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
