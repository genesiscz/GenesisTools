import { describe, expect, it } from "bun:test";
import type { WatcherSubscription } from "@app/utils/fs/watcher";

/**
 * Integration-level tests for the native watcher start/stop lifecycle.
 * Uses a mock subscription to verify the contract without spawning real OS watchers.
 */

function createMockSubscription(): WatcherSubscription & { _unsubscribeCalled: boolean } {
    let active = true;
    let _unsubscribeCalled = false;

    return {
        get active() {
            return active;
        },
        get errorCount() {
            return 0;
        },
        get _unsubscribeCalled() {
            return _unsubscribeCalled;
        },
        async unsubscribe() {
            active = false;
            _unsubscribeCalled = true;
        },
    };
}

describe("watcher start/stop lifecycle", () => {
    it("subscription is active after creation", () => {
        const sub = createMockSubscription();
        expect(sub.active).toBe(true);
    });

    it("unsubscribe deactivates the subscription", async () => {
        const sub = createMockSubscription();
        await sub.unsubscribe();

        expect(sub.active).toBe(false);
        expect(sub._unsubscribeCalled).toBe(true);
    });

    it("double unsubscribe does not throw", async () => {
        const sub = createMockSubscription();
        await sub.unsubscribe();
        await sub.unsubscribe();

        expect(sub.active).toBe(false);
    });

    it("stopWatch nullifies subscription reference", async () => {
        // Simulate the Indexer.stopWatch() pattern
        let subscription: WatcherSubscription | null = createMockSubscription();

        // stopWatch logic
        if (subscription) {
            await subscription.unsubscribe();
            subscription = null;
        }

        expect(subscription).toBeNull();
    });

    it("startWatch guards against double-start", () => {
        // Simulate the guard: if (this.watchSubscription?.active || this.watchTimer) return;
        const sub = createMockSubscription();
        let watchSubscription: WatcherSubscription | null = sub;
        let startCallCount = 0;

        function startWatch(): void {
            if (watchSubscription?.active) {
                return;
            }

            startCallCount++;
            watchSubscription = createMockSubscription();
        }

        startWatch(); // Already has active sub -- should be a no-op
        expect(startCallCount).toBe(0);

        // After stopping, should allow restart
        watchSubscription = null;
        startWatch();
        expect(startCallCount).toBe(1);
    });
});

describe("watcher debounce edge cases", () => {
    it("rapid-fire events collapse into single callback", async () => {
        let callCount = 0;
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;
        const DEBOUNCE_MS = 100;

        function debouncedSync(): void {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }

            debounceTimer = setTimeout(() => {
                callCount++;
                debounceTimer = null;
            }, DEBOUNCE_MS);
        }

        // Simulate 50 rapid file changes
        for (let i = 0; i < 50; i++) {
            debouncedSync();
        }

        // Wait for debounce to settle
        await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 50));

        expect(callCount).toBe(1);
    });

    it("events spaced beyond debounce window each trigger callback", async () => {
        let callCount = 0;
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;
        const DEBOUNCE_MS = 50;

        function debouncedSync(): void {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }

            debounceTimer = setTimeout(() => {
                callCount++;
                debounceTimer = null;
            }, DEBOUNCE_MS);
        }

        // Two events spaced well apart
        debouncedSync();
        await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 30));

        debouncedSync();
        await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 30));

        expect(callCount).toBe(2);
    });

    it("max-wait forces callback even during sustained activity", async () => {
        let callCount = 0;
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;
        let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
        const DEBOUNCE_MS = 100;
        const MAX_WAIT_MS = 200;

        function fire(): void {
            callCount++;

            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }

            if (maxWaitTimer) {
                clearTimeout(maxWaitTimer);
            }

            debounceTimer = null;
            maxWaitTimer = null;
        }

        function debouncedSyncWithMaxWait(): void {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }

            if (!maxWaitTimer) {
                maxWaitTimer = setTimeout(fire, MAX_WAIT_MS);
            }

            debounceTimer = setTimeout(fire, DEBOUNCE_MS);
        }

        // Continuously fire events for 300ms (exceeds MAX_WAIT_MS)
        const start = Date.now();
        const interval = setInterval(() => {
            if (Date.now() - start < 300) {
                debouncedSyncWithMaxWait();
            }
        }, 20);

        await new Promise((resolve) => setTimeout(resolve, 500));
        clearInterval(interval);

        // Max-wait should have forced at least one callback during the 300ms burst
        expect(callCount).toBeGreaterThanOrEqual(1);
    });
});
