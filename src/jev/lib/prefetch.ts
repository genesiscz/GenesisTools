import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("jev-prefetch");

export const PREFETCH_MAX_ITEMS = 3;
export const PREFETCH_MAX_AGE_MS = 2000;

export interface PrefetchPayload {
    element: number;
    action: "press" | "set" | "chrome" | "menu" | "click" | "app" | "narrow" | "confirm";
    chrome?: string;
    /**
     * The candidate's own id. A native row is identified by `element`, but a page node has no
     * element index, so a CDP surface identifies its rows by this instead.
     */
    uid?: string;
    /** Process to bring forward (`action: "app"`). */
    appPid?: number;
    /** Which narrowing to apply to the next utterance (`action: "narrow"`). */
    narrow?: string;
    /** Native menu item reference (`action: "menu"`), valid for one menu observation. */
    menuRef?: string;
}

export interface PrefetchItem {
    id: string;
    probability: number;
    payload: PrefetchPayload;
}

export interface PrefetchCache {
    snapshot: string;
    builtAtMs: number;
    items: PrefetchItem[];
}

export interface PrefetchCandidate {
    id: string;
    element: number;
    action: PrefetchPayload["action"];
    chrome?: string;
    menuRef?: string;
    appPid?: number;
    narrow?: string;
}

export function buildPrefetch(options: {
    distribution: Record<string, number>;
    snapshot: string;
    candidates: PrefetchCandidate[];
    now?: () => number;
}): PrefetchCache {
    const ranked = Object.entries(options.distribution)
        .filter(([id]) => id !== "abstain")
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, PREFETCH_MAX_ITEMS);
    const items: PrefetchItem[] = [];
    for (const [id, probability] of ranked) {
        const candidate = options.candidates.find((item) => item.id === id);
        if (!candidate) {
            continue;
        }

        items.push({
            id,
            probability,
            payload: {
                element: candidate.element,
                action: candidate.action,
                uid: candidate.id,
                ...(candidate.chrome === undefined ? {} : { chrome: candidate.chrome }),
                ...(candidate.menuRef === undefined ? {} : { menuRef: candidate.menuRef }),
                ...(candidate.appPid === undefined ? {} : { appPid: candidate.appPid }),
                ...(candidate.narrow === undefined ? {} : { narrow: candidate.narrow }),
            },
        });
    }
    return {
        snapshot: options.snapshot,
        builtAtMs: (options.now ?? Date.now)(),
        items,
    };
}

export function matchPrefetch(options: {
    cache: PrefetchCache | null;
    snapshot: string;
    winnerId: string;
    candidates?: PrefetchCandidate[];
    now?: () => number;
    maxAgeMs?: number;
}): PrefetchPayload | null {
    const cache = options.cache;
    if (!cache) {
        log.debug({ winnerId: options.winnerId }, "prefetch miss: no cache");
        return null;
    }

    const now = (options.now ?? Date.now)();
    const maxAge = options.maxAgeMs ?? PREFETCH_MAX_AGE_MS;
    const ageMs = now - cache.builtAtMs;
    if (cache.snapshot !== options.snapshot || ageMs > maxAge) {
        log.debug(
            { winnerId: options.winnerId, ageMs, maxAge, sameSnapshot: cache.snapshot === options.snapshot },
            "prefetch miss: stale snapshot or expired"
        );
        return null;
    }

    const item = cache.items.find((entry) => entry.id === options.winnerId);
    if (!item) {
        log.debug(
            { winnerId: options.winnerId, prefetched: cache.items.map((entry) => entry.id) },
            "prefetch miss: winner not prefetched"
        );
        return null;
    }

    if (
        options.candidates &&
        !options.candidates.some((candidate) => candidate.id === item.id && candidate.element === item.payload.element)
    ) {
        log.debug(
            { winnerId: options.winnerId, element: item.payload.element },
            "prefetch miss: candidate identity changed"
        );
        return null;
    }

    log.debug({ winnerId: options.winnerId, ageMs, action: item.payload.action }, "prefetch hit");
    return item.payload;
}
