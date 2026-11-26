/**
 * Freshness labels for published content. This module is safe to import in the browser.
 */

/** Where the page comes from: the Mac's vault at each request, or a snapshot a target holds. */
export type FreshnessMode = "live" | "snapshot";

export interface PublishedFreshness {
    mode: FreshnessMode;
    /** The source file's modification time (ISO), when it is known. */
    editedAt?: string;
    /** When the snapshot was taken (ISO); snapshot mode only. */
    syncedAt?: string;
}

/** The last successful send of a publication to one target. */
export interface SyncRecord {
    syncedAt: string;
    /** The source file's modification time when it was sent. */
    sourceModifiedAt: string;
    /** Content fingerprint when the source has additional build inputs. */
    sourceFingerprint?: string;
}

export type FreshnessTone = "fresh" | "recent" | "aging" | "stale";

const SECOND_MS = 1000;
const MINUTE_MS = 60_000;
/** "just now" only for a sync this recent; older than that the seconds show, so a sync of a minute ago never reads as fresh. */
export const JUST_NOW_MS = 10 * SECOND_MS;
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

/** "just now" (under 10 s), "25 s ago", "5 min ago", "3 h ago", "2 days ago", "5 weeks ago". */
export function formatAgo(ageMs: number): string {
    const age = Math.max(0, ageMs);
    const second = 1000;
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;

    if (age < 10_000) {
        return "just now";
    }

    if (age < minute) {
        return `${Math.floor(age / second)} s ago`;
    }

    if (age < hour) {
        return `${Math.floor(age / minute)} min ago`;
    }

    if (age < day) {
        return `${Math.floor(age / hour)} h ago`;
    }

    const days = Math.floor(age / day);

    if (days < 14) {
        return `${days} ${days === 1 ? "day" : "days"} ago`;
    }

    return `${Math.floor(days / 7)} weeks ago`;
}

/** The time the badge colour and its "ago" follow: the edit for a live page, the sync for a snapshot. */
export function freshnessAnchor(freshness: PublishedFreshness): string | undefined {
    return freshness.mode === "live" ? freshness.editedAt : (freshness.syncedAt ?? freshness.editedAt);
}

/** A file whose mtime moves by less than this is the same edit (file systems round mtimes differently). */
const SAME_EDIT_MS = 1000;

/** True when the source was edited after the version a target holds was sent. */
export function isEditedAfterSync(editedAt: string | undefined, sync: SyncRecord | undefined): boolean {
    if (!editedAt || !sync) {
        return false;
    }

    return Date.parse(editedAt) - Date.parse(sync.sourceModifiedAt) > SAME_EDIT_MS;
}
