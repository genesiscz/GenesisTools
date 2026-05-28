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

        // "killed" reads as terminated-by-signal. POSIX surfaces signal-
        // derived exits as code >= 128 (130 = SIGINT, 137 = SIGKILL, 143
        // = SIGTERM, etc.); any code < 128 is a normal program-driven
        // exit, including ordinary failures (lint, test, build returning
        // 1/2). The prior `code !== 0` classifier mislabeled every failing
        // test run as "killed", which is misleading in the dashboard UI.
        const killed = session.exitCode !== undefined && session.exitCode >= 128;
        const failed = session.exitCode !== undefined && session.exitCode !== 0 && !killed;
        const recency = resolveQaRecency(endedAt, now);

        const phase = killed ? "killed" : "exited";
        const stateLabel = killed
            ? "killed"
            : failed
              ? `exited (${session.exitCode})`
              : "exited";

        return {
            phase,
            stateLabel,
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
