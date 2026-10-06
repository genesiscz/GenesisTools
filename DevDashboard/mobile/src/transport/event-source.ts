import type { EventSourceLike } from "@dd/contract";
import { streamSse, type StreamSseOptions } from "@/transport/sse-parser";

export interface ReconnectingEventSourceOptions {
    url: string;
    headers?: Record<string, string>;
    stream?: (options: StreamSseOptions) => { close(): void };
    initialRetryMs?: number;
    maxRetryMs?: number;
    maxRetries?: number;
}

/** EventSource-compatible SSE adapter with bounded recovery and teardown-safe retry timers. */
export function createReconnectingEventSource(options: ReconnectingEventSourceOptions): EventSourceLike {
    const openStream = options.stream ?? streamSse;
    const initialRetryMs = options.initialRetryMs ?? 1_000;
    const maxRetryMs = options.maxRetryMs ?? 15_000;
    const maxRetries = options.maxRetries ?? 6;
    let onmessage: EventSourceLike["onmessage"] = null;
    let onopen: EventSourceLike["onopen"] = null;
    let onerror: EventSourceLike["onerror"] = null;
    let handle: { close(): void } | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retries = 0;
    let closed = false;

    const connect = () => {
        if (closed) {
            return;
        }

        handle = openStream({
            url: options.url,
            headers: options.headers,
            onOpen: () => onopen?.({}),
            onEvent: (event) => {
                retries = 0;
                onmessage?.({ data: event.data });
            },
            onEof: () => scheduleReconnect(new Error(`sse ${options.url} ended`)),
            onError: scheduleReconnect,
        });
    };

    const scheduleReconnect = (error: unknown) => {
        if (closed || retryTimer) {
            return;
        }

        handle?.close();
        handle = null;
        onerror?.(error);

        if (retries >= maxRetries) {
            return;
        }

        const delay = Math.min(initialRetryMs * 2 ** retries, maxRetryMs);
        retries += 1;
        retryTimer = setTimeout(() => {
            retryTimer = null;
            connect();
        }, delay);
    };

    queueMicrotask(connect);

    return {
        close() {
            closed = true;
            handle?.close();
            handle = null;

            if (retryTimer) {
                clearTimeout(retryTimer);
                retryTimer = null;
            }
        },
        get onmessage() {
            return onmessage;
        },
        set onmessage(handler) {
            onmessage = handler;
        },
        get onopen() {
            return onopen;
        },
        set onopen(handler) {
            onopen = handler;
        },
        get onerror() {
            return onerror;
        },
        set onerror(handler) {
            onerror = handler;
        },
    };
}
