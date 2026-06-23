import type { IndexedLogEntry } from "@app/debugging-master/types";
import { SafeJSON } from "@app/utils/json";
import type { LogSourceId } from "@app/utils/log-viewer/log-source";
import { sessionRoute } from "./api";

export type ConnectionStatus = "connecting" | "live" | "reconnecting" | "down";

export interface SseHandlers {
    onEntry: (entry: IndexedLogEntry) => void;
    onStatus: (status: ConnectionStatus) => void;
    onCleared?: () => void;
}

export interface MultiplexLogEntry extends IndexedLogEntry {
    source: LogSourceId;
    session: string;
}

export interface ActiveStreamHandlers {
    onEntry: (entry: MultiplexLogEntry) => void;
    onStatus: (status: ConnectionStatus) => void;
    onRemoved?: (source: LogSourceId, session: string) => void;
    onCleared?: (source: LogSourceId, session: string) => void;
}

const RECONNECT_DELAY_MS = 1500;
const MAX_RECONNECT_DELAY_MS = 15_000;
const OFFLINE_RETRY_MS = 10_000;

export function connectStream(source: LogSourceId, sessionName: string, handlers: SseHandlers): () => void {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let disposed = false;

    const open = (): void => {
        if (disposed) {
            return;
        }

        handlers.onStatus(attempt === 0 ? "connecting" : "reconnecting");
        es = new EventSource(`${sessionRoute(source, sessionName)}/stream`);

        es.addEventListener("open", () => {
            attempt = 0;
            handlers.onStatus("live");
        });

        es.addEventListener("entry", (ev: MessageEvent<string>) => {
            try {
                const parsed = SafeJSON.parse(ev.data, { strict: true }) as IndexedLogEntry;
                handlers.onEntry(parsed);
            } catch {
                // ignore malformed frames
            }
        });

        es.addEventListener("cleared", () => {
            handlers.onCleared?.();
        });

        es.addEventListener("error", () => {
            if (disposed) {
                return;
            }
            es?.close();
            es = null;
            attempt++;
            handlers.onStatus("reconnecting");
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            const delay =
                attempt > 4
                    ? OFFLINE_RETRY_MS
                    : Math.min(MAX_RECONNECT_DELAY_MS, RECONNECT_DELAY_MS * 2 ** Math.min(attempt - 1, 4));
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                open();
            }, delay);
        });
    };

    open();

    return () => {
        disposed = true;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
        }
        es?.close();
    };
}

export function connectActiveStream(handlers: ActiveStreamHandlers): () => void {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let disposed = false;

    const open = (): void => {
        if (disposed) {
            return;
        }

        handlers.onStatus(attempt === 0 ? "connecting" : "reconnecting");
        es = new EventSource("/api/sessions/stream?active=1");

        es.addEventListener("open", () => {
            attempt = 0;
            handlers.onStatus("live");
        });

        es.addEventListener("entry", (ev: MessageEvent<string>) => {
            try {
                const parsed = SafeJSON.parse(ev.data, { strict: true }) as MultiplexLogEntry;
                handlers.onEntry(parsed);
            } catch {
                // ignore malformed frames
            }
        });

        es.addEventListener("removed", (ev: MessageEvent<string>) => {
            try {
                const parsed = SafeJSON.parse(ev.data, { strict: true }) as { source: LogSourceId; session: string };
                handlers.onRemoved?.(parsed.source, parsed.session);
            } catch {
                // ignore malformed frames
            }
        });

        es.addEventListener("cleared", (ev: MessageEvent<string>) => {
            try {
                const parsed = SafeJSON.parse(ev.data, { strict: true }) as { source: LogSourceId; session: string };
                handlers.onCleared?.(parsed.source, parsed.session);
            } catch {
                // ignore malformed frames
            }
        });

        es.addEventListener("error", () => {
            if (disposed) {
                return;
            }
            es?.close();
            es = null;
            attempt++;
            handlers.onStatus("reconnecting");
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            const delay =
                attempt > 4
                    ? OFFLINE_RETRY_MS
                    : Math.min(MAX_RECONNECT_DELAY_MS, RECONNECT_DELAY_MS * 2 ** Math.min(attempt - 1, 4));
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                open();
            }, delay);
        });
    };

    open();

    return () => {
        disposed = true;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
        }
        es?.close();
    };
}
