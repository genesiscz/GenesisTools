import type { DashboardSession } from "./log-source";

export function sessionRecencyTs(session: DashboardSession): number {
    return Math.max(session.lastActivityAt, session.exitedAt ?? 0);
}

export function compareSessionsByRecency(a: DashboardSession, b: DashboardSession): number {
    return sessionRecencyTs(b) - sessionRecencyTs(a);
}

export function sortSessionsByRecency(sessions: readonly DashboardSession[]): DashboardSession[] {
    return [...sessions].sort(compareSessionsByRecency);
}
