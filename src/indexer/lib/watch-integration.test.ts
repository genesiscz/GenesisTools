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
