import type { LiveChannel } from "@dd/contract";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useDashboardClient } from "@/api/client-provider";
import { LIVE_CACHE_TABLE } from "@/live/cache-table";
import { createLiveCache, type LiveCache, type LiveStatus } from "@/live/live-cache";

const LiveCacheContext = createContext<LiveCache | null>(null);

/**
 * Owns the one live cache of a connection session. It sits inside the `ClientProvider` and the session's
 * `QueryClientProvider`, so a new client (another Mac, another tier) gets a fresh cache and the old stream closes.
 * AppState drives the foreground: a backgrounded app holds no open stream.
 */
export function LiveCacheProvider({ children }: { children: ReactNode }) {
    const client = useDashboardClient();
    const queryClient = useQueryClient();
    const cache = useMemo(
        () => createLiveCache({ client, queryClient, foreground: AppState.currentState === "active" }),
        [client, queryClient]
    );

    useEffect(() => {
        const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
            cache.setForeground(next === "active");
        });

        return () => {
            sub.remove();
            cache.close();
        };
    }, [cache]);

    return <LiveCacheContext.Provider value={cache}>{children}</LiveCacheContext.Provider>;
}

function useLiveCache(): LiveCache {
    const cache = useContext(LiveCacheContext);
    if (!cache) {
        throw new Error("live hooks must be used within a <LiveCacheProvider>");
    }

    return cache;
}

/** Asks for a channel while the calling component is mounted. Returns true while the stream carries it. */
export function useLiveChannel(channel: LiveChannel): boolean {
    const cache = useLiveCache();

    useEffect(() => cache.demand(channel), [cache, channel]);

    return useSyncExternalStore(cache.subscribe, () => cache.isLive(channel));
}

/**
 * The `refetchInterval` for a query a live channel covers: `false` while the channel is live, else the channel's
 * fallback poll from the cache table. Also asks for the channel, so a hook needs only this call.
 */
export function useLiveRefetchInterval(channel: LiveChannel): number | false {
    const live = useLiveChannel(channel);
    const fallback = LIVE_CACHE_TABLE[channel].fallbackMs;

    if (live || fallback === null) {
        return false;
    }

    return fallback;
}

/** The stream's status, for a header dot. */
export function useLiveStatus(): LiveStatus {
    const cache = useLiveCache();
    return useSyncExternalStore(cache.subscribe, cache.status);
}
