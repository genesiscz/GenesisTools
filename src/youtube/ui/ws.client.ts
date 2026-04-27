import { useEffect, useMemo, useState } from "react";
import { fetchUiConfig } from "@app/yt/config.client";
import type { JobEvent } from "@app/youtube/lib/types";

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
        close: () => ws.close(),
    };

    ws.onopen = () => {
        handle.connected = true;
        ws.send(JSON.stringify({ type: "subscribe", jobIds: opts.jobIds }));
    };

    ws.onclose = () => {
        handle.connected = false;
        opts.onClose?.();
    };

    ws.onmessage = (message) => {
        try {
            opts.onEvent?.(JSON.parse(message.data as string) as JobEvent);
        } catch {
        }
    };

    return handle;
}

export function useEventStream(opts: UseEventStreamOpts = {}) {
    const [connected, setConnected] = useState(false);
    const jobIdsKey = useMemo(() => opts.jobIds?.join(",") ?? "", [opts.jobIds]);

    useEffect(() => {
        if (opts.enabled === false) {
            return;
        }

        let active = true;
        let handle: EventStreamHandle | null = null;

        createEventStream({
            ...opts,
            onClose: () => {
                setConnected(false);
                opts.onClose?.();
            },
        })
            .then((stream) => {
                if (!active) {
                    stream.close();
                    return;
                }

                handle = stream;
                setConnected(stream.connected);
            })
            .catch(() => setConnected(false));

        const interval = window.setInterval(() => {
            setConnected(handle?.connected ?? false);
        }, 1000);

        return () => {
            active = false;
            window.clearInterval(interval);
            handle?.close();
        };
    }, [opts.enabled, jobIdsKey, opts.onEvent, opts.onClose]);

    return { connected };
}
