import type { DashboardSession } from "@app/utils/log-viewer/log-source";
import { activeSessionRetentionMs, DEFAULT_SESSION_POOL_SETTINGS } from "@/lib/session-pool-settings";

/** Default retention (1 hour) — matches task/debugging-master ACTIVE_THRESHOLD_MS. */
export const SESSION_ACTIVE_RETENTION_MS = activeSessionRetentionMs(DEFAULT_SESSION_POOL_SETTINGS);

export function sessionEndedAt(session: DashboardSession): number {
    if (session.exitedAt !== undefined && session.exitedAt > 0) {
        return session.exitedAt;
    }

    return session.lastActivityAt;
}

export function isSessionInActivePool(
    session: DashboardSession,
    now: number,
    retentionMs: number = SESSION_ACTIVE_RETENTION_MS
): boolean {
    if (session.state === "active") {
        return true;
    }

    const endedAt = sessionEndedAt(session);

    if (endedAt <= 0) {
        return false;
    }

    return now - endedAt < retentionMs;
}
