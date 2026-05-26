import type { DashboardSession } from "@app/utils/log-viewer/log-source";
import { formatLastMessageAgo } from "@app/utils/format";
import { resolveQaRecency } from "@app/utils/ui/helpers/qa-recency";

export type SessionLiveStatusPhase = "running" | "killed" | "exited" | "fallback";

export interface SessionLiveStatusDisplay {
    phase: SessionLiveStatusPhase;
    stateLabel: string;
    agoLabel: string | null;
    recencyTier: string | null;
}

export function resolveSessionLastMessageTs(session: DashboardSession, latestLineTs?: number): number {
    return Math.max(session.lastActivityAt, latestLineTs ?? 0);
}

export function formatStatusAgo(ts: number, now: number): string {
    return formatLastMessageAgo(Math.max(0, now - ts));
}

export function resolveSessionLiveStatusDisplay({
    session,
    latestLineTs,
    now,
}: {
    session: DashboardSession;
    latestLineTs?: number;
    now: number;
}): SessionLiveStatusDisplay {
    const lastMessageTs = resolveSessionLastMessageTs(session, latestLineTs);

    if (session.state === "active") {
        const recency = resolveQaRecency(lastMessageTs, now);

        return {
            phase: "running",
            stateLabel: "running",
            agoLabel: formatStatusAgo(lastMessageTs, now),
            recencyTier: recency.tier,
        };
    }

    if (session.state === "exited") {
        const endedAt = session.exitedAt && session.exitedAt > 0 ? session.exitedAt : lastMessageTs;

        if (endedAt <= 0) {
            return {
                phase: "fallback",
                stateLabel: session.stateLabel,
                agoLabel: null,
                recencyTier: null,
            };
        }

        const killed = session.exitCode !== undefined && session.exitCode !== 0;
        const recency = resolveQaRecency(endedAt, now);

        return {
            phase: killed ? "killed" : "exited",
            stateLabel: killed ? "killed" : "exited",
            agoLabel: formatStatusAgo(endedAt, now),
            recencyTier: recency.tier,
        };
    }

    return {
        phase: "fallback",
        stateLabel: session.stateLabel,
        agoLabel: null,
        recencyTier: null,
    };
}

/** @deprecated use resolveSessionLiveStatusDisplay */
export type SessionLiveStatusKind = "active" | "idle" | "fallback";

/** @deprecated use resolveSessionLiveStatusDisplay */
export function resolveSessionLiveStatusKind(session: DashboardSession, lastTs: number): SessionLiveStatusKind {
    if (session.state === "active") {
        return "active";
    }

    if (session.state === "exited" && lastTs > 0) {
        return "idle";
    }

    return "fallback";
}
