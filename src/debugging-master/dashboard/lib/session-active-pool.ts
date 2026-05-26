import type { DashboardSession } from "@app/utils/log-viewer/log-source";

/** Matches task/debugging-master ACTIVE_THRESHOLD_MS (1 hour). */
export const SESSION_ACTIVE_RETENTION_MS = 60 * 60 * 1000;

export function sessionEndedAt(session: DashboardSession): number {
    if (session.exitedAt !== undefined && session.exitedAt > 0) {
        return session.exitedAt;
    }

    return session.lastActivityAt;
}

export function isSessionInActivePool(session: DashboardSession, now: number): boolean {
    if (session.state === "active") {
        return true;
    }

    const endedAt = sessionEndedAt(session);

    if (endedAt <= 0) {
        return false;
    }

    return now - endedAt < SESSION_ACTIVE_RETENTION_MS;
}
