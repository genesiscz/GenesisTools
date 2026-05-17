import { SafeJSON } from "@app/utils/json";
import { useEffect, useRef } from "react";

export interface SseFrame<TName extends string = string> {
    type: TName;
    data: unknown;
}

export type SseStatus = "connecting" | "live" | "reconnecting" | "down";

export interface UseSseStreamOptions<TName extends string> {
    url: string;
    events: readonly TName[];
    onBatch: (batch: Array<SseFrame<TName>>) => void;
    onStatusChange?: (status: SseStatus) => void;
    enabled?: boolean;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_FACTOR = 2;

export interface SseSubscriptionOptions<TName extends string> {
    url: string;
    events: readonly TName[];
    onBatch: (batch: Array<SseFrame<TName>>) => void;
    onStatusChange?: (status: SseStatus) => void;
    /** Injection seam for tests. Defaults to the global EventSource. */
    EventSourceClass?: typeof EventSource;
    /** Injection seam for tests. Defaults to globalThis.requestAnimationFrame. */
    schedule?: (cb: () => void) => number;
    /** Injection seam for tests. Defaults to globalThis.cancelAnimationFrame. */
    cancel?: (id: number) => void;
}

export interface SseSubscription {
    close: () => void;
}

export function createSseSubscription<TName extends string>(opts: SseSubscriptionOptions<TName>): SseSubscription {
    const EventSourceImpl = opts.EventSourceClass ?? EventSource;
    const schedule = opts.schedule ?? requestAnimationFrame;
    const cancel = opts.cancel ?? cancelAnimationFrame;

    let stopped = false;
    let attempt = 0;
    let backoffMs = INITIAL_BACKOFF_MS;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let buffer: Array<SseFrame<TName>> = [];
    let rafId: number | null = null;

    const flush = (): void => {
        rafId = null;
        if (buffer.length === 0) {
            return;
        }

        const drained = buffer;
        buffer = [];
        opts.onBatch(drained);
    };

    const scheduleFlush = (): void => {
        if (rafId !== null) {
            return;
        }

        rafId = schedule(flush);
    };

    const setStatus = (s: SseStatus): void => {
        opts.onStatusChange?.(s);
    };

    const open = (): void => {
        if (stopped) {
            return;
        }

        setStatus(attempt === 0 ? "connecting" : "reconnecting");
        es = new EventSourceImpl(opts.url) as EventSource;

        es.addEventListener("open", () => {
            attempt = 0;
            backoffMs = INITIAL_BACKOFF_MS;
            setStatus("live");
        });

        for (const name of opts.events) {
            es.addEventListener(name, (ev: Event) => {
                const messageEvent = ev as MessageEvent<string>;
                try {
                    const data = SafeJSON.parse(messageEvent.data);
                    buffer.push({ type: name, data } as SseFrame<TName>);
                    scheduleFlush();
                } catch {
                    // Malformed frame — drop silently; keep stream alive.
                }
            });
        }

        es.addEventListener("error", () => {
            if (stopped) {
                return;
            }

            es?.close();
            es = null;
            attempt++;
            setStatus(attempt > 4 ? "down" : "reconnecting");
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
            }

            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                open();
            }, backoffMs);
            backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * BACKOFF_FACTOR);
        });
    };

    open();

    return {
        close: (): void => {
            stopped = true;
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
            }

            if (rafId !== null) {
                cancel(rafId);
            }

            es?.close();
            setStatus("down");
        },
    };
}

export function useSseStream<TName extends string>({
    url,
    events,
    onBatch,
    onStatusChange,
    enabled = true,
}: UseSseStreamOptions<TName>): void {
    const onBatchRef = useRef(onBatch);
    const onStatusRef = useRef(onStatusChange);
    onBatchRef.current = onBatch;
    onStatusRef.current = onStatusChange;

    useEffect(() => {
        if (!enabled) {
            return;
        }

        const sub = createSseSubscription({
            url,
            events,
            onBatch: (batch) => onBatchRef.current(batch),
            onStatusChange: (s) => onStatusRef.current?.(s),
        });

        return () => sub.close();
    }, [url, enabled, events]);
}
