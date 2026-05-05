import type { IndexedLogEntry } from "@app/debugging-master/types";
import { SafeJSON } from "@app/utils/json";

export type ConnectionStatus = "connecting" | "live" | "reconnecting" | "down";

export interface SseHandlers {
    onEntry: (entry: IndexedLogEntry) => void;
    onStatus: (status: ConnectionStatus) => void;
    onCleared?: () => void;
}

const RECONNECT_DELAY_MS = 1500;
const MAX_RECONNECT_DELAY_MS = 15_000;

/**
 * Connect to the live SSE stream for a session. Returns a disposer; call it
 * to close the connection and cancel pending reconnects.
 */
export function connectStream(sessionName: string, handlers: SseHandlers): () => void {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let disposed = false;

    const open = (): void => {
        if (disposed) {
            return;
        }

        handlers.onStatus(attempt === 0 ? "connecting" : "reconnecting");
        es = new EventSource(`/api/sessions/${sessionName}/stream`);

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
            handlers.onStatus(attempt > 4 ? "down" : "reconnecting");
            // Defensive: cancel any pending reconnect before scheduling a new
            // one. Some browsers can fire `error` more than once for the same
            // dead socket; without this, two reconnect timers could race and
            // open duplicate streams.
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            const delay = Math.min(MAX_RECONNECT_DELAY_MS, RECONNECT_DELAY_MS * 2 ** Math.min(attempt - 1, 4));
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
        handlers.onStatus("down");
    };
}
