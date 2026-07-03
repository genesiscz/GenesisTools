import { fetchSnapshot } from "@app/dev-dashboard/lib/cmux/client";
import type { CmuxSnapshot } from "@app/dev-dashboard/lib/cmux/types";
import { logger } from "@app/logger";
import { startWakefulInterval, type WakefulInterval } from "@app/utils/async";

const IDLE_THRESHOLD_MS = 60_000;

let cached: CmuxSnapshot | null = null;
let handle: WakefulInterval | null = null;
let lastClientSeenAt = 0;
let activeOpts: CmuxPollingOptions | null = null;

export interface CmuxPollingOptions {
    fetchOverride?: () => Promise<CmuxSnapshot>;
}

async function refreshWith(opts: CmuxPollingOptions | null): Promise<CmuxSnapshot> {
    cached = opts?.fetchOverride ? await opts.fetchOverride() : await fetchSnapshot();
    return cached;
}

export function markClientSeen(): void {
    const wasIdle = lastClientSeenAt !== 0 && Date.now() - lastClientSeenAt > IDLE_THRESHOLD_MS;
    lastClientSeenAt = Date.now();

    if (wasIdle && handle) {
        void refreshWith(activeOpts).catch((err) => {
            logger.debug({ err }, "cmux immediate refresh after idle failed");
        });
    }
}

export function getCachedSnapshot(): CmuxSnapshot {
    if (cached) {
        return cached;
    }

    return { fetchedAt: new Date().toISOString(), available: false, workspaces: [], panes: [] };
}

export async function refreshOnce(): Promise<CmuxSnapshot> {
    return refreshWith(null);
}

export function startPolling(intervalMs: number, opts: CmuxPollingOptions = {}): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        logger.warn({ intervalMs }, "cmux polling not started: invalid interval");
        return;
    }

    if (handle) {
        return;
    }

    lastClientSeenAt = 0;
    activeOpts = opts;

    handle = startWakefulInterval(intervalMs, async () => {
        if (Date.now() - lastClientSeenAt > IDLE_THRESHOLD_MS) {
            return;
        }

        await refreshWith(opts);
    });
}

export function stopPolling(): void {
    if (!handle) {
        return;
    }

    handle.stop();
    handle = null;
    lastClientSeenAt = 0;
    activeOpts = null;
}
