import { paths } from "@app/dev-dashboard/contract/endpoints";
import type { LiveChannel, LiveFrame } from "@app/dev-dashboard/lib/live/types";
import type { PortInfo, PortsResult } from "@app/dev-dashboard/lib/ports/types";
import { SafeJSON } from "@app/utils/json";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

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
 * Single multiplexed EventSource to `/api/live`. Merges frames into React Query.
 * Mid-session channel changes: POST /api/live/subscribe (SSE cannot receive).
 */
export function useLive(channels: LiveChannel[]): {
    connId: string | null;
    setChannels: (ch: LiveChannel[]) => Promise<void>;
    lastError: string | null;
} {
    const qc = useQueryClient();
    const [connId, setConnId] = useState<string | null>(null);
    const [lastError, setLastError] = useState<string | null>(null);
    const connIdRef = useRef<string | null>(null);
    const channelsKey = channels.slice().sort().join(",");
    const activeKey = useRef<string | null>(null);

    useEffect(() => {
        if (activeKey.current === channelsKey) {
            return;
        }

        activeKey.current = channelsKey;
        const url = paths.live(channels);
        const es = new EventSource(url);

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

                if (frame.channel === "qa" && frame.type === "entry") {
                    qc.setQueryData(["qa", "live-entry"], frame.payload);
                    // Let QA page listeners also invalidate list
                    void qc.invalidateQueries({ queryKey: ["qa"] });
                    return;
                }

                if (
                    typeof frame.channel === "string" &&
                    frame.channel.startsWith("boards:") &&
                    frame.type === "event"
                ) {
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
            if (activeKey.current === channelsKey) {
                activeKey.current = null;
            }

            connIdRef.current = null;
            setConnId(null);
        };
    }, [channelsKey, qc, channels]); // channels used in EventSource URL via paths.live(channels)

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
