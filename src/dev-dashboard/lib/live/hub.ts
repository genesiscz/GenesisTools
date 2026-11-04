import { randomUUID } from "node:crypto";
import type { LiveChannel, LiveFrame } from "@app/dev-dashboard/lib/live/types";
import type { SseEmitter } from "@app/dev-dashboard/server/types";
import { SafeJSON } from "@genesiscz/utils/json";

interface Conn {
    id: string;
    emit: SseEmitter;
    channels: Set<LiveChannel>;
}

export interface LiveHub {
    open(emit: SseEmitter, initial: LiveChannel[]): { connId: string; close: () => void };
    setChannels(connId: string, channels: LiveChannel[]): LiveChannel[] | null;
    publish(frame: LiveFrame): void;
    /** Deliver a frame to one connection only: a system frame, or a data frame of a channel it subscribes to. */
    publishTo(connId: string, frame: LiveFrame): void;
    subscriberCount(channel: LiveChannel): number;
    /**
     * Demand moved by one: `delta` 1 when connection `connId` added `channel`, -1 when it dropped it or closed. The
     * connection id lets a producer send its current value to the connection that just joined.
     */
    onDemandChange(cb: DemandListener): () => void;
    _reset(): void;
}

export type DemandListener = (channel: LiveChannel, delta: 1 | -1, connId: string) => void;

export function createLiveHub(options: { serialize?: (frame: LiveFrame) => string } = {}): LiveHub {
    const conns = new Map<string, Conn>();
    const demand = new Map<LiveChannel, number>();
    const demandListeners = new Set<DemandListener>();
    const serialize = options.serialize ?? ((frame: LiveFrame) => SafeJSON.stringify(frame));

    function bump(ch: LiveChannel, delta: 1 | -1, connId: string): void {
        const n = (demand.get(ch) ?? 0) + delta;
        if (n <= 0) {
            demand.delete(ch);
        } else {
            demand.set(ch, n);
        }

        for (const fn of demandListeners) {
            fn(ch, delta, connId);
        }
    }

    /** The set changes before the listeners run, so a snapshot sent from a +1 callback passes `publishTo`'s check. */
    function applyChannels(conn: Conn, next: LiveChannel[]): void {
        const prev = conn.channels;
        const nextSet = new Set(next);
        conn.channels = nextSet;

        for (const ch of prev) {
            if (!nextSet.has(ch)) {
                bump(ch, -1, conn.id);
            }
        }

        for (const ch of nextSet) {
            if (!prev.has(ch)) {
                bump(ch, 1, conn.id);
            }
        }
    }

    function send(conn: Conn, frame: LiveFrame): void {
        conn.emit.data(serialize(frame));
    }

    return {
        open(emit, initial) {
            const id = randomUUID();
            const conn: Conn = { id, emit, channels: new Set() };
            conns.set(id, conn);
            // Hello goes first: a producer answers a new subscriber with its snapshot from the demand callback, and
            // the client must know its connection id before any data frame arrives.
            send(conn, {
                v: 1,
                channel: "system",
                type: "hello",
                payload: { connId: id, channels: [...new Set(initial)] },
            });
            applyChannels(conn, initial);

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

            const next = [...new Set(channels)];
            send(conn, { v: 1, channel: "system", type: "subscribed", payload: { channels: next } });
            applyChannels(conn, next);
            return next;
        },

        publish(frame) {
            let payload: string | undefined;

            if (frame.channel === "system") {
                return;
            }

            for (const conn of conns.values()) {
                if (conn.channels.has(frame.channel)) {
                    payload ??= serialize(frame);
                    conn.emit.data(payload);
                }
            }
        },

        publishTo(connId, frame) {
            const conn = conns.get(connId);
            if (!conn) {
                return;
            }

            // A snapshot can land after its connection dropped the channel again.
            if (frame.channel !== "system" && !conn.channels.has(frame.channel)) {
                return;
            }

            send(conn, frame);
        },

        subscriberCount(channel) {
            return demand.get(channel) ?? 0;
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
