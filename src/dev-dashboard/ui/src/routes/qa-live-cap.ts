import type { QaRow } from "@app/dev-dashboard/lib/qa-types";

export const QA_LIVE_HORIZON_MS = 24 * 60 * 60 * 1000;

export function evictQaEntriesPastHorizon(
    live: QaRow[],
    seen: Set<string>,
    readAtById: Map<string, number>,
    now: number,
    horizonMs: number = QA_LIVE_HORIZON_MS
): { live: QaRow[]; seen: Set<string>; readAtById: Map<string, number> } {
    const cutoff = now - horizonMs;
    const evictedIds = new Set(live.filter((entry) => entry.ts < cutoff).map((entry) => entry.id));
    const nextLive = live.filter((entry) => entry.ts >= cutoff);

    if (evictedIds.size === 0) {
        return { live: nextLive, seen, readAtById };
    }

    const nextSeen = new Set(seen);
    const nextReadAt = new Map(readAtById);

    for (const id of evictedIds) {
        nextSeen.delete(id);
        nextReadAt.delete(id);
    }

    return { live: nextLive, seen: nextSeen, readAtById: nextReadAt };
}

export function prependQaLiveEntry(
    live: QaRow[],
    entry: QaRow,
    seen: Set<string>,
    readAtById: Map<string, number>,
    now: number,
    horizonMs: number = QA_LIVE_HORIZON_MS
): { live: QaRow[]; seen: Set<string>; readAtById: Map<string, number> } {
    return evictQaEntriesPastHorizon([entry, ...live], seen, readAtById, now, horizonMs);
}