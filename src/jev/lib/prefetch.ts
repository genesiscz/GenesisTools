export const PREFETCH_MAX_ITEMS = 3;
export const PREFETCH_MAX_AGE_MS = 2000;

export interface PrefetchPayload {
    element: number;
    action: "press" | "set" | "chrome";
    chrome?: string;
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
    action: "press" | "set" | "chrome";
    chrome?: string;
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
                ...(candidate.chrome === undefined ? {} : { chrome: candidate.chrome }),
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
        return null;
    }

    const now = (options.now ?? Date.now)();
    const maxAge = options.maxAgeMs ?? PREFETCH_MAX_AGE_MS;
    if (cache.snapshot !== options.snapshot || now - cache.builtAtMs > maxAge) {
        return null;
    }

    const item = cache.items.find((entry) => entry.id === options.winnerId);
    if (!item) {
        return null;
    }

    if (
        options.candidates &&
        !options.candidates.some((candidate) => candidate.id === item.id && candidate.element === item.payload.element)
    ) {
        return null;
    }

    return item.payload;
}
