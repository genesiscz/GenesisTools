/**
 * How fresh a shared page is, for the badge on the share page and the chips in the dashboard reader. Pure: the
 * browser bundle imports it too.
 */

/** Where the page comes from: the Mac's vault at each request, or a snapshot a target holds. */
export type ShareFreshnessMode = "live" | "snapshot";

export interface ShareFreshness {
    mode: ShareFreshnessMode;
    /** The note file's modification time (ISO), when it is known. */
    editedAt?: string;
    /** When the snapshot was taken (ISO); snapshot mode only. */
    syncedAt?: string;
}

/** The last successful send of a note to one target. */
export interface ShareSyncRecord {
    syncedAt: string;
    /** The note file's modification time when it was sent. */
    sourceModifiedAt: string;
}

export type FreshnessTone = "fresh" | "recent" | "aging" | "stale";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Green under an hour, blue under a day, amber under a week, grey after. */
export const FRESHNESS_TONE_LIMITS: ReadonlyArray<{ tone: FreshnessTone; underMs: number }> = [
    { tone: "fresh", underMs: HOUR_MS },
    { tone: "recent", underMs: DAY_MS },
    { tone: "aging", underMs: 7 * DAY_MS },
];

export function freshnessTone(ageMs: number): FreshnessTone {
    return FRESHNESS_TONE_LIMITS.find((limit) => ageMs < limit.underMs)?.tone ?? "stale";
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", "5 weeks ago". */
export function formatAgo(ageMs: number): string {
    const age = Math.max(0, ageMs);

    if (age < MINUTE_MS) {
        return "just now";
    }

    if (age < HOUR_MS) {
        return `${Math.floor(age / MINUTE_MS)} min ago`;
    }

    if (age < DAY_MS) {
        return `${Math.floor(age / HOUR_MS)} h ago`;
    }

    const days = Math.floor(age / DAY_MS);

    if (days < 14) {
        return `${days} ${days === 1 ? "day" : "days"} ago`;
    }

    return `${Math.floor(days / 7)} weeks ago`;
}

/** The time the badge colour and its "ago" follow: the edit for a live page, the sync for a snapshot. */
export function freshnessAnchor(freshness: ShareFreshness): string | undefined {
    return freshness.mode === "live" ? freshness.editedAt : (freshness.syncedAt ?? freshness.editedAt);
}

/** A file whose mtime moves by less than this is the same edit (file systems round mtimes differently). */
const SAME_EDIT_MS = 1000;

/** True when the note was edited after the version a target holds was sent. */
export function isEditedAfterSync(editedAt: string | undefined, sync: ShareSyncRecord | undefined): boolean {
    if (!editedAt || !sync) {
        return false;
    }

    return Date.parse(editedAt) - Date.parse(sync.sourceModifiedAt) > SAME_EDIT_MS;
}
