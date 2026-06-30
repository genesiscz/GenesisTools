import { fetchSnapshot } from "@app/dev-dashboard/lib/cmux/client";
import type { CmuxSnapshot } from "@app/dev-dashboard/lib/cmux/types";
import { logger } from "@app/logger";
import { startWakefulInterval, type WakefulInterval } from "@app/utils/async";

const IDLE_THRESHOLD_MS = 60_000;

let cached: CmuxSnapshot | null = null;
let handle: WakefulInterval | null = null;
let lastClientSeenAt = 0;

export interface CmuxPollingOptions {
    fetchOverride?: () => Promise<CmuxSnapshot>;
}

export function markClientSeen(): void {
    lastClientSeenAt = Date.now();
}

export function getCachedSnapshot(): CmuxSnapshot {
    if (cached) {
        return cached;
    }

    return { fetchedAt: new Date().toISOString(), available: false, workspaces: [], panes: [] };
}

export async function refreshOnce(): Promise<CmuxSnapshot> {
    cached = await fetchSnapshot();
    return cached;
}

export function startPolling(intervalMs: number, opts: CmuxPollingOptions = {}): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        logger.warn({ intervalMs }, "cmux polling not started: invalid interval");
        return;
    }

    if (handle) {
        return;
    }

    handle = startWakefulInterval(intervalMs, async () => {
        if (Date.now() - lastClientSeenAt > IDLE_THRESHOLD_MS) {
            return;
        }

        if (opts.fetchOverride) {
            cached = await opts.fetchOverride();
            return;
        }

        await refreshOnce();
    });
}

export function stopPolling(): void {
    if (!handle) {
        return;
    }

    handle.stop();
    handle = null;
}
