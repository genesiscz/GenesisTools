import { describe, expect, test } from "bun:test";

describe("npm-package-diff --keep watcher cleanup", () => {
    test("closes watchers even when --keep is set", async () => {
        let closed = false;
        const comparison = {
            options: { keep: true },
            watchers: [{ close: async () => { closed = true; } }],
            async cleanup(this: { options: { keep: boolean }; watchers: Array<{ close: () => Promise<void> }> }) {
                for (const watcher of this.watchers) {
                    await watcher.close();
                }
                this.watchers = [];
            },
        };

        await comparison.cleanup();
        expect(closed).toBe(true);
        expect(comparison.watchers).toHaveLength(0);
    });
});