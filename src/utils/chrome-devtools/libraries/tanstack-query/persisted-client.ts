import { SafeJSON } from "@genesiscz/utils/json";

export interface PersistedQuery {
    index: number;
    queryKey: unknown[];
    /** `String(queryKey[0])`. */
    prefix: string;
    queryHash: string;
    status: string;
    dataUpdatedAt: number;
    /** UTF-8 bytes of the query's data as stored. */
    dataBytes: number;
    /** UTF-8 bytes of the whole stored query plus its share of the superjson meta. */
    totalBytes: number;
    superjsonMetaBytes: number;
    arrayLength?: number;
    topLevelKeys?: string[];
}

export interface PersistedClientAnalysis {
    encoding: "superjson" | "json";
    /** UTF-8 bytes of the whole stored string. */
    bytes: number;
    /** Length of the stored string in UTF-16 code units, as the storage layer holds it. */
    chars: number;
    buster: string;
    timestamp: number;
    queries: PersistedQuery[];
    mutations: number;
    superjsonMetaBytes: number;
    /** Meta that could not be tied to one query (a non-flat meta shape, or paths outside the queries). */
    unattributedMetaBytes: number;
}

export interface PersistedPrefixGroup {
    prefix: string;
    entries: number;
    totalBytes: number;
    dataBytes: number;
    superjsonMetaBytes: number;
    /** Share of all queries' `totalBytes`, 0 to 1. */
    share: number;
}

interface PersistedClientState {
    buster?: string;
    timestamp?: number;
    clientState?: {
        queries?: Array<{
            queryKey?: unknown[];
            queryHash?: string;
            state?: { data?: unknown; dataUpdatedAt?: number; status?: string };
        }>;
        mutations?: unknown[];
    };
}

const encoder = new TextEncoder();
const utf8 = (text: string): number => encoder.encode(text).length;
const jsonBytes = (value: unknown): number => utf8(SafeJSON.stringify(value ?? null, { strict: true }) ?? "null");
const QUERY_META_PATH = /^clientState\.queries\.(\d+)\./;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Sizes a persisted TanStack Query client (the string a persister stores), per query, in plain JSON
 * or superjson encoding. For superjson it attributes each flat meta path to its query, so a query whose
 * dates or undefineds dominate its stored size shows it. Pure: no superjson package needed.
 */
export function analyzePersistedClient(raw: string): PersistedClientAnalysis {
    const parsed: unknown = SafeJSON.parse(raw, { strict: true });
    if (!isRecord(parsed)) {
        throw new Error("the persisted client is not a JSON object");
    }

    const isSuperjson = isRecord(parsed.json) && isRecord(parsed.json.clientState);
    const envelope = (isSuperjson ? parsed.json : parsed) as PersistedClientState;
    if (!isRecord(envelope.clientState)) {
        throw new Error("no clientState in the persisted client");
    }

    const metaShare = new Map<number, number>();
    let superjsonMetaBytes = 0;
    let unattributedMetaBytes = 0;
    if (isSuperjson && isRecord(parsed.meta)) {
        superjsonMetaBytes = jsonBytes(parsed.meta);
        const values = parsed.meta.values;
        if (isRecord(values)) {
            let attributed = 0;
            for (const [path, value] of Object.entries(values)) {
                const match = QUERY_META_PATH.exec(path);
                if (!match) {
                    continue;
                }

                const share = utf8(path) + jsonBytes(value) + 4;
                const index = Number(match[1]);
                metaShare.set(index, (metaShare.get(index) ?? 0) + share);
                attributed += share;
            }

            unattributedMetaBytes = Math.max(0, superjsonMetaBytes - attributed);
        } else {
            unattributedMetaBytes = superjsonMetaBytes;
        }
    }

    const queries = (envelope.clientState.queries ?? []).map((query, index): PersistedQuery => {
        const queryKey = Array.isArray(query.queryKey) ? query.queryKey : [];
        const data = query.state?.data;
        const meta = metaShare.get(index) ?? 0;
        const row: PersistedQuery = {
            index,
            queryKey,
            prefix: String(queryKey[0]),
            queryHash: query.queryHash ?? "",
            status: query.state?.status ?? "",
            dataUpdatedAt: query.state?.dataUpdatedAt ?? 0,
            dataBytes: jsonBytes(data),
            totalBytes: jsonBytes(query) + meta,
            superjsonMetaBytes: meta,
        };
        if (Array.isArray(data)) {
            row.arrayLength = data.length;
        } else if (isRecord(data)) {
            row.topLevelKeys = Object.keys(data).slice(0, 12);
        }

        return row;
    });

    return {
        encoding: isSuperjson ? "superjson" : "json",
        bytes: utf8(raw),
        chars: raw.length,
        buster: String(envelope.buster ?? ""),
        timestamp: Number(envelope.timestamp ?? 0),
        queries,
        mutations: envelope.clientState.mutations?.length ?? 0,
        superjsonMetaBytes,
        unattributedMetaBytes,
    };
}

/** Groups persisted queries by their first key element, largest first. */
export function groupPersistedByPrefix(queries: PersistedQuery[]): PersistedPrefixGroup[] {
    const total = queries.reduce((sum, query) => sum + query.totalBytes, 0) || 1;
    const groups = new Map<string, PersistedPrefixGroup>();
    for (const query of queries) {
        const group = groups.get(query.prefix) ?? {
            prefix: query.prefix,
            entries: 0,
            totalBytes: 0,
            dataBytes: 0,
            superjsonMetaBytes: 0,
            share: 0,
        };
        group.entries += 1;
        group.totalBytes += query.totalBytes;
        group.dataBytes += query.dataBytes;
        group.superjsonMetaBytes += query.superjsonMetaBytes;
        groups.set(query.prefix, group);
    }

    return [...groups.values()]
        .map((group) => ({ ...group, share: group.totalBytes / total }))
        .sort((a, b) => b.totalBytes - a.totalBytes);
}
