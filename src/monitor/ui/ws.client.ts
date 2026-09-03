import type { MonitorEvent } from "@app/monitor/lib/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger/client";
import { useEffect, useRef, useState } from "react";
import { reportBackendReachable, reportBackendUnreachable } from "./backend-status";

export interface UseEventStreamOpts {
    enabled?: boolean;
    onEvent?: (event: MonitorEvent) => void;
}

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000, 10_000, 30_000];

/** Injected by vite.config.ts; absent when the built bundle is served by the monitor server itself. */
declare const __MONITOR_API_ORIGIN__: string | undefined;

function eventsUrl(): string {
    const origin =
        typeof __MONITOR_API_ORIGIN__ === "string" && __MONITOR_API_ORIGIN__
            ? __MONITOR_API_ORIGIN__
            : window.location.origin;

    return `${origin.replace(/^http/, "ws")}/api/v1/events`;
}

/** WebSocket to the monitor server; reconnects with backoff. */
export function useEventStream(opts: UseEventStreamOpts = {}) {
    const [connected, setConnected] = useState(false);
    const latestOpts = useRef(opts);
    const enabled = opts.enabled !== false;

    useEffect(() => {
        latestOpts.current = opts;
    });

    useEffect(() => {
        if (!enabled) {
            setConnected(false);

            return;
        }

        let active = true;
        let attempt = 0;
        let socket: WebSocket | null = null;
        let timer: number | null = null;

        function connect() {
            const ws = new WebSocket(eventsUrl());
            socket = ws;

            ws.onopen = () => {
                attempt = 0;
                setConnected(true);
                reportBackendReachable();
            };

            ws.onmessage = (message) => {
                try {
                    latestOpts.current.onEvent?.(SafeJSON.parse(message.data as string) as MonitorEvent);
                } catch (error) {
                    logger.debug({ error }, "ws.client: failed to parse event");
                }
            };

            ws.onclose = () => {
                if (!active) {
                    return;
                }

                setConnected(false);
                attempt += 1;

                if (attempt >= 2) {
                    reportBackendUnreachable("Live event stream disconnected");
                }

                const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
                timer = window.setTimeout(connect, delay);
            };

            ws.onerror = () => {
                ws.close();
            };
        }

        connect();

        return () => {
            active = false;

            if (timer !== null) {
                window.clearTimeout(timer);
            }

            if (socket) {
                socket.onclose = null;
                socket.onerror = null;
                socket.close();
            }
        };
    }, [enabled]);

    return { connected };
}
