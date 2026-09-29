import { paths } from "@app/dev-dashboard/contract/endpoints";
import type { LiveChannel, LiveFrame } from "@app/dev-dashboard/lib/live/types";
import type { PortInfo, PortsResult } from "@app/dev-dashboard/lib/ports/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePageVisible } from "@/hooks/usePageVisible";

function portKey(p: PortInfo): string {
    return `${p.pid}:${p.port}:${p.proto}`;
}

function mergeClassify(prev: PortsResult | undefined, updates: PortInfo[]): PortsResult | undefined {
    if (!prev) {
        return prev;
    }

    const map = new Map(updates.map((p) => [portKey(p), p]));
    return {
        ...prev,
        ports: prev.ports.map((p) => map.get(portKey(p)) ?? p),
    };
}

/**
 * What an `ai-usage` poll actually changes. `["ai"]` would also match
 * `["ai", "spend", …]`, whose answer comes from a transcript scan a poll cannot
 * affect (sweep 2026-09-04, N1).
 */
export const AI_USAGE_KEYS: ReadonlyArray<readonly string[]> = [
    ["ai", "usage"],
    ["ai", "accounts"],
    ["ai", "daemon"],
];

/**
 * Identity-free description of a subscription. Every caller passes a fresh array
 * literal, so the array itself changes on every render; the effect must key off
 * this string instead or it tears the stream down and rebuilds it each time.
 */
export function liveChannelsKey(channels: readonly LiveChannel[]): string {
    return channels.slice().sort().join(",");
}

export function channelsFromKey(key: string): LiveChannel[] {
    return key.split(",").filter(Boolean) as LiveChannel[];
}

/**
 * Single multiplexed EventSource to `/api/live`. Merges frames into React Query.
 * Mid-session channel changes: POST /api/live/subscribe (SSE cannot receive).
 *
 * The stream is open only while the page is visible and at least one channel is asked for.
 * The server runs a channel's producer (the ports `lsof` scan and its HTTP classify probes,
 * the pulse sampler, the AI usage poller) for as long as anyone subscribes, so a background
 * tab used to keep them all running. On return the stream reopens and the next producer tick
 * brings fresh data (at once when this tab is the only subscriber, since that restarts it).
 */
export interface LiveConnectionDeps {
    qc: QueryClient;
    connIdRef: { current: string | null };
    setConnId: (id: string | null) => void;
    setLastError: (message: string | null) => void;
    /** A fake in tests; the browser global otherwise. */
    EventSourceCtor?: typeof EventSource;
}

/**
 * The effect body of `useLive`, pulled out so a test can drive it without rendering the hook: a
 * fake `EventSourceCtor` stands in for the browser global, and the return value is the same
 * cleanup React would call. `visible` and `channelsKey === ""` both mean no connection: the
 * caller gets `undefined` back instead of a cleanup, exactly like the effect returning early.
 */
export function openLiveConnection(
    channelsKey: string,
    visible: boolean,
    deps: LiveConnectionDeps
): (() => void) | undefined {
    if (!visible || channelsKey === "") {
        return undefined;
    }

    const { qc, connIdRef, setConnId, setLastError } = deps;
    const ESCtor = deps.EventSourceCtor ?? EventSource;
    const es = new ESCtor(paths.live(channelsFromKey(channelsKey)));

    es.onmessage = (ev) => {
        try {
            const frame = SafeJSON.parse(ev.data, { strict: true }) as LiveFrame;

            if (frame.channel === "system" && frame.type === "hello") {
                connIdRef.current = frame.payload.connId;
                setConnId(frame.payload.connId);
                setLastError(null);
                return;
            }

            if (frame.channel === "system" && frame.type === "error") {
                setLastError(frame.payload.message);
                return;
            }

            if (frame.channel === "ports" && frame.type === "snapshot") {
                qc.setQueryData(["ports"], frame.payload);
                return;
            }

            if (frame.channel === "ports" && frame.type === "classify") {
                qc.setQueryData<PortsResult>(["ports"], (prev) => mergeClassify(prev, frame.payload.ports));
                return;
            }

            if (frame.channel === "pulse" && frame.type === "snapshot") {
                qc.setQueryData(["pulse", "snap"], frame.payload);
                return;
            }

            if (frame.channel === "ai-usage" && frame.type === "snapshot") {
                // A poll refreshes rate-limit windows and poller health, and
                // says nothing about recorded spend. Invalidating all of `ai`
                // sent the spend queries out a second time every cycle, and
                // each of those is a transcript scan.
                for (const key of AI_USAGE_KEYS) {
                    void qc.invalidateQueries({ queryKey: key });
                }

                return;
            }

            if (frame.channel === "qa" && frame.type === "entry") {
                qc.setQueryData(["qa", "live-entry"], frame.payload);
                // Let QA page listeners also invalidate list
                void qc.invalidateQueries({ queryKey: ["qa"] });
                return;
            }

            if (typeof frame.channel === "string" && frame.channel.startsWith("boards:") && frame.type === "event") {
                const slug = frame.channel.slice("boards:".length);
                void qc.invalidateQueries({ queryKey: ["board", slug] });
                void qc.invalidateQueries({ queryKey: ["board-sections", slug] });
                return;
            }

            if (typeof frame.channel === "string" && frame.channel.startsWith("daemon:") && frame.type === "log") {
                qc.setQueryData(["daemon", "live-log", frame.channel], frame.payload);
            }
        } catch {
            // ignore malformed
        }
    };

    es.onerror = () => {
        setLastError("live stream disconnected");
    };

    return () => {
        es.close();
        connIdRef.current = null;
        setConnId(null);
    };
}

export function useLive(channels: LiveChannel[]): {
    connId: string | null;
    setChannels: (ch: LiveChannel[]) => Promise<void>;
    lastError: string | null;
} {
    const qc = useQueryClient();
    const [connId, setConnId] = useState<string | null>(null);
    const [lastError, setLastError] = useState<string | null>(null);
    const connIdRef = useRef<string | null>(null);
    const channelsKey = liveChannelsKey(channels);
    const visible = usePageVisible();

    useEffect(() => {
        return openLiveConnection(channelsKey, visible, { qc, connIdRef, setConnId, setLastError });
        // `channels` is deliberately absent: the array identity changes every
        // render, and depending on it reopened the stream about eight times a
        // second. `channelsKey` carries the same information and is stable.
    }, [channelsKey, qc, visible]);

    const setChannels = useCallback(async (ch: LiveChannel[]) => {
        const id = connIdRef.current;
        if (!id) {
            throw new Error("live stream not connected");
        }

        const res = await fetch(paths.liveSubscribe(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: SafeJSON.stringify({ connId: id, channels: ch }),
        });

        if (!res.ok) {
            throw new Error(`subscribe failed: ${res.status}`);
        }
    }, []);

    return { connId, setChannels, lastError };
}
