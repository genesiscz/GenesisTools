import type { SearchResult } from "@app/utils/search/types";

// ─── Base timestamp (epoch ms, injected by emit) ────────────────
type Ts = { ts: number };

// ─── Sync stats ──────────────────────────────────────────────────
export interface SyncStats {
    filesScanned: number;
    chunksAdded: number;
    chunksUpdated: number;
    chunksRemoved: number;
    chunksUnchanged: number;
    embeddingsGenerated: number;
    durationMs: number;
}

// ─── Event map: single source of truth ──────────────────────────
export interface IndexerEventMap {
    "scan:start": Ts & { indexName: string; strategy: string };
    "scan:complete": Ts & {
        indexName: string;
        added: number;
        modified: number;
        deleted: number;
        unchanged: number;
    };

    "chunk:file": Ts & {
        indexName: string;
        filePath: string;
        chunks: number;
        parser: "ast" | "line" | "heading" | "message" | "json";
    };
    "chunk:skip": Ts & {
        indexName: string;
        filePath: string;
        reason: "unchanged" | "ignored" | "binary";
    };

    "embed:start": Ts & {
        indexName: string;
        totalChunks: number;
        provider: string;
        dimensions: number;
    };
    "embed:progress": Ts & {
        indexName: string;
        completed: number;
        total: number;
        currentFile: string;
    };
    "embed:complete": Ts & {
        indexName: string;
        embedded: number;
        skipped: number;
        durationMs: number;
    };

    "sync:start": Ts & { indexName: string; mode: "incremental" | "full" };
    "sync:complete": Ts & {
        indexName: string;
        durationMs: number;
        stats: SyncStats;
    };
    "sync:error": Ts & {
        indexName: string;
        error: string;
        filePath?: string;
    };

    "watch:start": Ts & { indexName: string; strategy: string };
    "watch:change": Ts & {
        indexName: string;
        filePath: string;
        event: "add" | "modify" | "delete";
    };
    "watch:stop": Ts & { indexName: string };

    "search:query": Ts & {
        indexName: string;
        query: string;
        mode: string;
        results: SearchResult<Record<string, unknown>>[];
        resultsCount: number;
        durationMs: number;
        cached: boolean;
    };
}

// ─── Derived types ──────────────────────────────────────────────
export type EventName = keyof IndexerEventMap;

export type Namespace = EventName extends `${infer NS}:${string}` ? NS : never;

export type EventsIn<NS extends Namespace> = Extract<EventName, `${NS}:${string}`>;

export type WildcardPayload<NS extends Namespace> = {
    [K in EventsIn<NS>]: IndexerEventMap[K] & { event: K };
}[EventsIn<NS>];

// ─── Inline callbacks derived from event map ────────────────────
type CamelEvent<S extends string> = S extends `${infer NS}:${infer A}` ? `on${Capitalize<NS>}${Capitalize<A>}` : never;

export type IndexerCallbacks = {
    [K in EventName as CamelEvent<K>]?: (payload: IndexerEventMap[K]) => void;
};

// ─── Emitter interface ──────────────────────────────────────────
type AnyWildcardPayload = {
    [NS in Namespace]: WildcardPayload<NS>;
}[Namespace];

export interface IndexerEmitter {
    on<K extends EventName>(event: K, handler: (payload: IndexerEventMap[K]) => void): this;
    on<NS extends Namespace>(event: `${NS}:*`, handler: (payload: WildcardPayload<NS>) => void): this;
    on(event: "*", handler: (payload: AnyWildcardPayload) => void): this;

    off<K extends EventName>(event: K, handler: (payload: IndexerEventMap[K]) => void): this;
    // biome-ignore lint/suspicious/noExplicitAny: event emitter stores heterogeneous handlers by design
    off(event: string, handler: (payload: any) => void): this;

    emit<K extends EventName>(event: K, payload: Omit<IndexerEventMap[K], "ts">): void;
}

// ─── Map an event name to its callback key ──────────────────────
function eventToCallbackKey(event: string): string {
    const [ns, action] = event.split(":");

    if (!ns || !action) {
        return "";
    }

    return `on${ns.charAt(0).toUpperCase()}${ns.slice(1)}${action.charAt(0).toUpperCase()}${action.slice(1)}`;
}

// ─── Generic handler type (satisfies biome noBannedTypes) ────────
// biome-ignore lint/suspicious/noExplicitAny: event emitter stores heterogeneous handlers by design
type Handler = (payload: any) => void;

// ─── Implementation ─────────────────────────────────────────────
export class IndexerEventEmitter implements IndexerEmitter {
    private handlers = new Map<string, Set<Handler>>();

    on<K extends EventName>(event: K, handler: (payload: IndexerEventMap[K]) => void): this;
    on<NS extends Namespace>(event: `${NS}:*`, handler: (payload: WildcardPayload<NS>) => void): this;
    on(event: "*", handler: (payload: AnyWildcardPayload) => void): this;
    on(event: string, handler: Handler): this {
        let set = this.handlers.get(event);

        if (!set) {
            set = new Set();
            this.handlers.set(event, set);
        }

        set.add(handler);
        return this;
    }

    off<K extends EventName>(event: K, handler: (payload: IndexerEventMap[K]) => void): this;
    off(event: string, handler: Handler): this;
    off(event: string, handler: Handler): this {
        const set = this.handlers.get(event);

        if (set) {
            set.delete(handler);

            if (set.size === 0) {
                this.handlers.delete(event);
            }
        }

        return this;
    }

    emit<K extends EventName>(event: K, payload: Omit<IndexerEventMap[K], "ts">): void {
        const full = { ...payload, ts: Date.now() } as IndexerEventMap[K];

        // Exact handlers
        const exact = this.handlers.get(event);

        if (exact) {
            for (const fn of exact) {
                fn(full);
            }
        }

        // Namespace wildcard handlers (e.g. "embed:*")
        const ns = event.split(":")[0];
        const wildcard = this.handlers.get(`${ns}:*`);

        if (wildcard) {
            const wildcardPayload = { ...full, event } as IndexerEventMap[K] & {
                event: K;
            };

            for (const fn of wildcard) {
                fn(wildcardPayload);
            }
        }

        // Global wildcard handlers ("*")
        const global = this.handlers.get("*");

        if (global) {
            const globalPayload = { ...full, event } as IndexerEventMap[K] & {
                event: K;
            };

            for (const fn of global) {
                fn(globalPayload);
            }
        }
    }

    dispatchCallbacks<K extends EventName>(event: K, payload: IndexerEventMap[K], callbacks?: IndexerCallbacks): void {
        if (!callbacks) {
            return;
        }

        const key = eventToCallbackKey(event);

        if (!key) {
            return;
        }

        // biome-ignore lint/suspicious/noExplicitAny: dynamic callback dispatch by computed key
        const fn = (callbacks as Record<string, ((payload: any) => void) | undefined>)[key];

        if (fn) {
            fn(payload);
        }
    }
}
