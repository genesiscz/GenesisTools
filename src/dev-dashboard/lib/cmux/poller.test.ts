import { afterEach, describe, expect, test } from "bun:test";

describe("cmux poller client-gating", () => {
    afterEach(async () => {
        const { stopPolling } = await import("./poller");
        stopPolling();
    });

    test("does not fetch when no client has connected recently", async () => {
        const { startPolling } = await import("./poller");
        let fetchCount = 0;

        startPolling(50, {
            fetchOverride: async () => {
                fetchCount++;
                return { fetchedAt: new Date().toISOString(), available: false, workspaces: [], panes: [] };
            },
        });
        await new Promise((r) => setTimeout(r, 200));

        expect(fetchCount).toBeLessThanOrEqual(1);
    });

    test("resumes fetching once a client connects", async () => {
        const { startPolling, markClientSeen } = await import("./poller");
        let fetchCount = 0;

        startPolling(50, {
            fetchOverride: async () => {
                fetchCount++;
                return { fetchedAt: new Date().toISOString(), available: false, workspaces: [], panes: [] };
            },
        });
        markClientSeen();
        await new Promise((r) => setTimeout(r, 200));

        expect(fetchCount).toBeGreaterThan(1);
    });
});
