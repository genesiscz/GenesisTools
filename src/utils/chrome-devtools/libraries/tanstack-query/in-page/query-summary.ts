export interface QuerySummaryArgs {
    /** The window property holding the QueryClient, as set by `findReactProps` with `exposeAs`. */
    slot: string;
    /** Measure each query's data as UTF-8 JSON bytes. Default true. */
    sizes?: boolean;
    /** Cut each serialized query key to this many characters. Default 300. */
    maxKeyChars?: number;
    /** Also return the data of the queries whose first key element is one of these. */
    dataFor?: string[];
}

export interface QueryRow {
    /** The query key as JSON, cut to `maxKeyChars`. */
    key: string;
    /** `String(queryKey[0])`. */
    prefix: string;
    hash: string;
    status: string;
    fetchStatus: string;
    /** -1 when the query threw while counting. */
    observers: number;
    /** UTF-8 bytes of `JSON.stringify(data)`; null when sizes are off, -1 when the data does not serialize. */
    dataBytes: number | null;
    dataUpdatedAt: number;
    stale: boolean | null;
    /** `query.meta` as plain JSON, or null. */
    meta: unknown;
}

export interface QuerySummary {
    queries: QueryRow[];
    mutations: number;
    data: Array<{ key: string; data: unknown }>;
    error?: string;
}

/**
 * Summarizes every query of a TanStack Query client kept on `window[slot]`: key, status, observers,
 * data size and meta. Read-only. Self-contained: only its source text reaches the page.
 */
export function querySummary(args: QuerySummaryArgs): QuerySummary {
    type Query = {
        queryKey?: unknown[];
        queryHash?: string;
        state?: { status?: string; fetchStatus?: string; data?: unknown; dataUpdatedAt?: number };
        meta?: unknown;
        options?: { meta?: unknown };
        getObserversCount?: () => number;
        isStale?: () => boolean;
    };
    type Client = {
        getQueryCache?: () => { getAll(): Query[] };
        getMutationCache?: () => { getAll(): unknown[] };
    };

    const result: QuerySummary = { queries: [], mutations: 0, data: [] };
    const client = (window as unknown as Record<string, unknown>)[args.slot] as Client | undefined;
    if (!client || typeof client.getQueryCache !== "function") {
        result.error = `window.${args.slot} holds no QueryClient`;
        return result;
    }

    const sizes = args.sizes ?? true;
    const maxKeyChars = args.maxKeyChars ?? 300;
    const wanted = new Set(args.dataFor ?? []);
    const encoder = new TextEncoder();

    const json = (value: unknown): string | null => {
        try {
            // biome-ignore lint/style/noRestrictedGlobals: in-page code runs in the browser and cannot import SafeJSON
            return JSON.stringify(value ?? null) ?? "null";
        } catch {
            return null;
        }
    };

    const plain = (value: unknown): unknown => {
        const text = json(value);
        // biome-ignore lint/style/noRestrictedGlobals: in-page code runs in the browser and cannot import SafeJSON
        return text === null ? null : JSON.parse(text);
    };

    for (const query of client.getQueryCache().getAll()) {
        const queryKey = Array.isArray(query.queryKey) ? query.queryKey : [];
        const key = (json(queryKey) ?? "[?]").slice(0, maxKeyChars);
        const prefix = String(queryKey[0]);
        const state = query.state ?? {};
        let dataBytes: number | null = null;
        if (sizes) {
            const text = json(state.data);
            dataBytes = text === null ? -1 : encoder.encode(text).length;
        }

        let stale: boolean | null = null;
        try {
            stale = typeof query.isStale === "function" ? query.isStale() : null;
        } catch {
            stale = null;
        }

        let observers = 0;
        try {
            observers = typeof query.getObserversCount === "function" ? query.getObserversCount() : 0;
        } catch {
            // One query that throws here must not cost the whole summary; -1 marks it unknown.
            observers = -1;
        }

        result.queries.push({
            key,
            prefix,
            hash: query.queryHash ?? "",
            status: state.status ?? "",
            fetchStatus: state.fetchStatus ?? "",
            observers,
            dataBytes,
            dataUpdatedAt: state.dataUpdatedAt ?? 0,
            stale,
            meta: plain(query.meta ?? query.options?.meta ?? null),
        });

        if (wanted.has(prefix)) {
            result.data.push({ key, data: plain(state.data) });
        }
    }

    result.mutations = typeof client.getMutationCache === "function" ? client.getMutationCache().getAll().length : 0;
    return result;
}
