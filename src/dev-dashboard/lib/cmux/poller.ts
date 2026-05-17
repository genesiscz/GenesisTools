import { fetchSnapshot } from "@app/dev-dashboard/lib/cmux/client";
import type { CmuxSnapshot } from "@app/dev-dashboard/lib/cmux/types";
import logger from "@app/logger";

let cached: CmuxSnapshot | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

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

    if (timer) {
        return;
    }

    timer = setInterval(() => {
        refreshOnce().catch((err) => logger.debug({ err }, "cmux poll failed"));
    }, intervalMs);

    refreshOnce().catch((err) => logger.debug({ err }, "cmux initial poll failed"));
}

export function stopPolling(): void {
    if (!timer) {
        return;
    }

    clearInterval(timer);
    timer = null;
}
