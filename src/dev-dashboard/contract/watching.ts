/**
 * One Watching screen for every watch on the Mac (F30). Types only (`contract-purity.test.ts`). The rows come from
 * `tools hub watching` (`/api/gateway/watching`), one source table on the Mac (`src/hub/lib/watching`).
 */

/** Every watch source. Hotels stays listed with a reason while it lives on a local-only branch. */
export type WatchSourceId = "monitor" | "domains" | "shops" | "tradingview" | "hotels";

/** `alert`: something to look at now (a fired alert, a price under target, a degraded check). */
export type WatchStateDto = "ok" | "alert" | "down" | "paused" | "unknown";

export interface WatchRowDto {
    source: WatchSourceId;
    /** Unique within its source. */
    id: string;
    title: string;
    state: WatchStateDto;
    /** The last change in words: the newest item, the check detail, the price against its target. */
    detail: string;
    changedAt: string | null;
    link: string | null;
    mutedUntil: string | null;
    /** Whether the Mac can silence this row (`POST /api/watching/mute`). */
    canMute: boolean;
}

export interface WatchSourceDto {
    id: WatchSourceId;
    label: string;
    count: number;
    /** Why the source has no rows: not set up, signed out, a read that failed, or not on this branch. */
    note: string | null;
}

export interface WatchingDto {
    generatedAt: string;
    sources: WatchSourceDto[];
    /** Alerts and outages first, then newest change first. */
    rows: WatchRowDto[];
}

export interface WatchMuteInput {
    source: WatchSourceId;
    id: string;
    /** Minutes from now; 0 lifts the mute. */
    minutes: number;
}

export interface WatchMuteReceiptDto {
    source: WatchSourceId;
    id: string;
    muted: boolean;
    mutedUntil: string | null;
    detail: string;
}
