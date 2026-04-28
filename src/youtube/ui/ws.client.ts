import { SafeJSON } from "@app/utils/json";
import type { JobEvent } from "@app/youtube/lib/types";
import { fetchUiConfig } from "@app/yt/config.client";
import { useEffect, useMemo, useRef, useState } from "react";

export interface UseEventStreamOpts {
    enabled?: boolean;
    jobIds?: number[];
    onEvent?: (event: JobEvent) => void;
    onClose?: () => void;
}

export interface EventStreamHandle {
    connected: boolean;
    close: () => void;
}

export async function createEventStream(opts: UseEventStreamOpts = {}): Promise<EventStreamHandle> {
    const { config } = await fetchUiConfig();
    const url = `${config.apiBaseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/api/v1/events`;
    const ws = new WebSocket(url);
    const handle: EventStreamHandle = {
        connected: false,
        close: () => {
            ws.onclose = null;
            ws.onerror = null;
            ws.close();
        },
    };

    ws.onerror = () => {
        handle.connected = false;
    };

    ws.onopen = () => {
        handle.connected = true;
        ws.send(SafeJSON.stringify({ type: "subscribe", jobIds: opts.jobIds }));
    };

    ws.onclose = () => {
        handle.connected = false;
        opts.onClose?.();
    };

    ws.onmessage = (message) => {
        try {
            opts.onEvent?.(SafeJSON.parse(message.data as string) as JobEvent);
        } catch {}
    };

    return handle;
}

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000, 10_000, 30_000];

export function useEventStream(opts: UseEventStreamOpts = {}) {
    const [connected, setConnected] = useState(false);
    const [reconnects, setReconnects] = useState(0);
    const latestOpts = useRef(opts);
    latestOpts.current = opts;

    const enabled = opts.enabled !== false;
    const jobIdsKey = useMemo(() => opts.jobIds?.join(",") ?? "", [opts.jobIds]);

    useEffect(() => {
        if (!enabled) {
            setConnected(false);
            return;
        }

        let active = true;
        let attempt = 0;
        let handle: EventStreamHandle | null = null;
        let reconnectTimer: number | null = null;

        function scheduleConnect(initial: boolean) {
            const delay = initial ? 0 : RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];

            reconnectTimer = window.setTimeout(() => {
                if (!active) {
                    return;
                }

                createEventStream({
                    jobIds: latestOpts.current.jobIds,
                    onEvent: (event) => latestOpts.current.onEvent?.(event),
                    onClose: () => {
                        if (!active) {
                            return;
                        }

                        setConnected(false);
                        latestOpts.current.onClose?.();
                        attempt += 1;
                        setReconnects((value) => value + 1);
                        scheduleConnect(false);
                    },
                })
                    .then((stream) => {
                        if (!active) {
                            stream.close();
                            return;
                        }

                        handle = stream;
                        attempt = 0;
                        setConnected(stream.connected);
                    })
                    .catch(() => {
                        if (!active) {
                            return;
                        }

                        setConnected(false);
                        attempt += 1;
                        scheduleConnect(false);
                    });
            }, delay) as unknown as number;
        }

        scheduleConnect(true);

        const interval = window.setInterval(() => {
            setConnected(handle?.connected ?? false);
        }, 1000);

        return () => {
            active = false;

            if (reconnectTimer !== null) {
                window.clearTimeout(reconnectTimer);
            }

            window.clearInterval(interval);
            handle?.close();
        };
    }, [enabled, jobIdsKey]);

    return { connected, reconnects };
}
