import { formatClock } from "@genesiscz/utils/format";

/**
 * A suppressed account, as every renderer needs to read it.
 *
 * Structural on purpose: the TUI takes `AccountUsageSnapshot` from the AI layer and the
 * dashboard card takes its own wire copy from the dev-dashboard contract, and this one
 * function has to serve both without either importing the other's type.
 */
export interface BlockedSnapshot {
    blocked?: { until: string; failures: number };
    error?: string;
}

/** Enough of the reason to recognise it; a usage API body can run to 200 characters. */
const REASON_MAX = 60;

function shorten(reason: string): string {
    const collapsed = reason.replace(/\s+/g, " ").trim();

    return collapsed.length > REASON_MAX ? `${collapsed.slice(0, REASON_MAX - 1)}…` : collapsed;
}

/**
 * "blocked until 14:35 (3 failures): Grok session token expired", or null when the account
 * is not suppressed right now.
 *
 * The raw error alone is what the TUI and the dashboard used to show, and it reads as "this
 * is happening now" — so a network blip that had long since cleared looked like a live
 * failure for hours, with nothing saying the account was merely waiting out a backoff.
 */
export function formatBlockedNotice(snapshot: BlockedSnapshot, now: number = Date.now()): string | null {
    const blocked = snapshot.blocked;

    if (!blocked) {
        return null;
    }

    const until = Date.parse(blocked.until);

    // An expired stamp means the next round will poll it, so saying "blocked" would be a lie.
    if (!Number.isFinite(until) || until <= now) {
        return null;
    }

    const failures = `${blocked.failures} ${blocked.failures === 1 ? "failure" : "failures"}`;
    const reason = snapshot.error ? `: ${shorten(snapshot.error)}` : "";

    return `blocked until ${formatClock(until)} (${failures})${reason}`;
}
