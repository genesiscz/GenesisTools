import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWatcher, type WatcherEvent, type WatcherSubscription } from "./watcher";

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
