import type { DashboardClient, LiveChannel, LiveDataFrame, LiveSubscription } from "@dd/contract";
import type { QueryClient } from "@tanstack/react-query";
import { LIVE_CACHE_TABLE, type LiveCacheTable, rowOf } from "@/live/cache-table";

/**
 * - `"off"`: no stream, because nothing asks for a channel or the app is in the background.
 * - `"connecting"`: the stream is opening and has not said hello.
 * - `"live"`: the stream is open; frames of the asked channels write the cache.
 * - `"down"`: the stream dropped; its reconnecting adapter is retrying or gave up. Screens poll meanwhile.
 */
export type LiveStatus = "off" | "connecting" | "live" | "down";

export interface LiveCache {
    /** A mounted screen asks for a channel; the returned function releases it. Counted per channel. */
    demand(channel: LiveChannel): () => void;
    /** The app came to the foreground (true) or left it (false). The stream is open only in the foreground. */
    setForeground(active: boolean): void;
    status(): LiveStatus;
    /** True when the stream is live and carries this channel, so its screen may stop polling. */
    isLive(channel: LiveChannel): boolean;
    /** Called when the status or the streamed channel set changes; returns the unsubscribe (`useSyncExternalStore`). */
    subscribe(listener: () => void): () => void;
    /**
     * Closes the stream now. Not final: a demand that arrives later opens it again, which is what React's double
     * effect run in development needs. A cache whose client is gone gets no more demand, so it stays closed.
     */
    close(): void;
}

export interface LiveCacheOptions {
    client: DashboardClient;
    queryClient: QueryClient;
    table?: LiveCacheTable;
    /** The foreground state at creation. */
    foreground?: boolean;
}

/** Writes one frame into the cache through its channel's row. */
export function applyLiveFrame(table: LiveCacheTable, frame: LiveDataFrame, queryClient: QueryClient): void {
    rowOf(table, frame.channel).apply(frame, queryClient);
}

/**
 * The phone's one live stream (M4). It owns the foreground lifecycle and the channel demand of mounted screens, opens
 * one `client.live.subscribe` while both say so, and writes each frame into TanStack Query through the cache table.
 * Demand changes are applied on a microtask, so a screen that unmounts while the next one mounts moves the channel
 * set once instead of closing and reopening the stream.
 */
export function createLiveCache(options: LiveCacheOptions): LiveCache {
    const { client, queryClient } = options;
    const table = options.table ?? LIVE_CACHE_TABLE;
    const demand = new Map<LiveChannel, number>();
    const listeners = new Set<() => void>();
    let foreground = options.foreground ?? true;
    let status: LiveStatus = "off";
    let subscription: LiveSubscription | null = null;
    let streamChannels: LiveChannel[] = [];
    let scheduled = false;

    function emit(): void {
        for (const listener of listeners) {
            listener();
        }
    }

    function setStatus(next: LiveStatus): void {
        if (next === status) {
            return;
        }

        status = next;
        emit();
    }

    function wanted(): LiveChannel[] {
        return [...demand.keys()].sort();
    }

    function stop(): void {
        subscription?.close();
        subscription = null;
        streamChannels = [];
        setStatus("off");
    }

    function reconcile(): void {
        scheduled = false;
        const channels = wanted();
        if (!foreground || channels.length === 0) {
            stop();
            return;
        }

        if (subscription) {
            const added = channels.filter((channel) => !streamChannels.includes(channel));
            for (const channel of added) {
                for (const queryKey of rowOf(table, channel).resync) {
                    void queryClient.invalidateQueries({ queryKey });
                }
            }

            streamChannels = channels;
            subscription.setChannels(channels);
            emit();
            return;
        }

        streamChannels = channels;
        setStatus("connecting");
        subscription = client.live.subscribe(channels, {
            onFrame: (frame) => {
                if (streamChannels.includes(frame.channel)) {
                    applyLiveFrame(table, frame, queryClient);
                }
            },
            onConnect: () => {
                setStatus("live");
                for (const channel of streamChannels) {
                    for (const queryKey of rowOf(table, channel).resync) {
                        void queryClient.invalidateQueries({ queryKey });
                    }
                }
            },
            onError: () => {
                if (subscription) {
                    setStatus("down");
                }
            },
        });
    }

    function schedule(): void {
        if (scheduled) {
            return;
        }

        scheduled = true;
        queueMicrotask(reconcile);
    }

    return {
        demand(channel) {
            demand.set(channel, (demand.get(channel) ?? 0) + 1);
            schedule();
            let released = false;

            return () => {
                if (released) {
                    return;
                }

                released = true;
                const left = (demand.get(channel) ?? 1) - 1;
                if (left <= 0) {
                    demand.delete(channel);
                } else {
                    demand.set(channel, left);
                }

                schedule();
            };
        },
        setForeground(active) {
            if (active === foreground) {
                return;
            }

            foreground = active;
            schedule();
        },
        status: () => status,
        isLive: (channel) => status === "live" && streamChannels.includes(channel),
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        close() {
            stop();
        },
    };
}
