import { randomUUID } from "node:crypto";
import type { LiveChannel, LiveFrame } from "@app/dev-dashboard/lib/live/types";
import type { SseEmitter } from "@app/dev-dashboard/server/types";
import { SafeJSON } from "@app/utils/json";

interface Conn {
    id: string;
    emit: SseEmitter;
    channels: Set<LiveChannel>;
}

export interface LiveHub {
    open(emit: SseEmitter, initial: LiveChannel[]): { connId: string; close: () => void };
    setChannels(connId: string, channels: LiveChannel[]): LiveChannel[] | null;
    publish(frame: LiveFrame): void;
    /** Deliver a system frame to one connection only. */
    publishTo(connId: string, frame: LiveFrame): void;
    subscriberCount(prefixOrChannel: string): number;
    onDemandChange(cb: (channel: LiveChannel, delta: 1 | -1) => void): () => void;
    _reset(): void;
}

export function createLiveHub(): LiveHub {
    const conns = new Map<string, Conn>();
    const demand = new Map<string, number>();
    const demandListeners = new Set<(c: LiveChannel, d: 1 | -1) => void>();

    function bump(ch: LiveChannel, delta: 1 | -1): void {
        const n = (demand.get(ch) ?? 0) + delta;
        if (n <= 0) {
            demand.delete(ch);
        } else {
            demand.set(ch, n);
        }

        for (const fn of demandListeners) {
            fn(ch, delta);
        }
    }

    function applyChannels(conn: Conn, next: LiveChannel[]): void {
        const nextSet = new Set(next);

        for (const ch of conn.channels) {
            if (!nextSet.has(ch)) {
                bump(ch, -1);
            }
        }

        for (const ch of nextSet) {
            if (!conn.channels.has(ch)) {
                bump(ch, 1);
            }
        }

        conn.channels = nextSet;
    }

    function send(conn: Conn, frame: LiveFrame): void {
        conn.emit.data(SafeJSON.stringify(frame));
    }

    return {
        open(emit, initial) {
            const id = randomUUID();
            const conn: Conn = { id, emit, channels: new Set() };
            conns.set(id, conn);
            applyChannels(conn, initial);
            send(conn, {
                v: 1,
                channel: "system",
                type: "hello",
                payload: { connId: id, channels: [...initial] },
            });

            return {
                connId: id,
                close: () => {
                    applyChannels(conn, []);
                    conns.delete(id);
                },
            };
        },

        setChannels(connId, channels) {
            const conn = conns.get(connId);
            if (!conn) {
                return null;
            }

            applyChannels(conn, channels);
            send(conn, {
                v: 1,
                channel: "system",
                type: "subscribed",
                payload: { channels: [...channels] },
            });
            return [...channels];
        },

        publish(frame) {
            for (const conn of conns.values()) {
                if (frame.channel === "system") {
                    continue;
                }

                if (conn.channels.has(frame.channel as LiveChannel)) {
                    send(conn, frame);
                }
            }
        },

        publishTo(connId, frame) {
            const conn = conns.get(connId);
            if (conn) {
                send(conn, frame);
            }
        },

        subscriberCount(prefixOrChannel) {
            let n = 0;
            for (const [ch, c] of demand) {
                if (ch === prefixOrChannel || ch.startsWith(`${prefixOrChannel}:`)) {
                    n += c;
                }
            }

            return n;
        },

        onDemandChange(cb) {
            demandListeners.add(cb);
            return () => {
                demandListeners.delete(cb);
            };
        },

        _reset() {
            conns.clear();
            demand.clear();
            demandListeners.clear();
        },
    };
}
