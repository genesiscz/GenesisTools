import { afterEach, describe, expect, test } from "bun:test";
import type { PulseSnapshot } from "./types";

const emptySnapshot = (): PulseSnapshot => ({
    cpuPct: null,
    memUsedBytes: null,
    memTotalBytes: null,
    memFreePct: null,
    swapUsedBytes: null,
    swapTotalBytes: null,
    batteryPct: null,
    batteryState: null,
    diskFreeBytes: null,
    diskTotalBytes: null,
    wifiSsid: null,
    publicIp: null,
    topProcesses: [],
    capturedAt: new Date().toISOString(),
});

describe("system pulse poller client-gating", () => {
    afterEach(async () => {
        const { stopPulsePolling } = await import("./poller");
        stopPulsePolling();
    });

    test("pauses collection when no client has fetched /api/system/pulse recently", async () => {
        const { startPulsePolling } = await import("./poller");
        let collectCount = 0;

        startPulsePolling(50, {
            collectOverride: async () => {
                collectCount++;
                return emptySnapshot();
            },
        });
        await new Promise((r) => setTimeout(r, 200));

        expect(collectCount).toBeLessThanOrEqual(1);
    });
});
