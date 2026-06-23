import { fetchSnapshot } from "@app/dev-dashboard/lib/cmux/client";
import type { CmuxSnapshot } from "@app/dev-dashboard/lib/cmux/types";
import { logger } from "@app/logger";
import { startWakefulInterval, type WakefulInterval } from "@app/utils/async";

let cached: CmuxSnapshot | null = null;
let handle: WakefulInterval | null = null;

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

export function startPolling(intervalMs: number): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        logger.warn({ intervalMs }, "cmux polling not started: invalid interval");
        return;
    }

    if (handle) {
        return;
    }

    handle = startWakefulInterval(intervalMs, async () => {
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
