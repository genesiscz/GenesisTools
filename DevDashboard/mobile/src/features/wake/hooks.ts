import type { WakeRelayDto } from "@dd/contract";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import { useDashboardClient, useIsMockClient } from "@/api/client-provider";
import { HEALTH_INTERVAL_MS, healthQuery, relayQuery, sendWake, WAKE_PATIENCE_MS } from "@/features/wake/queries";
import { createRelayStore, type RelayStore } from "@/features/wake/relay-store";
import { useConnectionStore } from "@/state/connection-store";

const secureRelayStore = createRelayStore(SecureStore);

/** The relay from the Mac while it answers, else the copy stored the last time it did. */
export function useWakeRelay(store: RelayStore = secureRelayStore): {
    relay: WakeRelayDto | null;
    fromMac: boolean;
    isPending: boolean;
} {
    // The relay is stored per Mac only while that Mac's own client answers, never the fixture's.
    const connectionId = useConnectionStore((s) => s.activeId);
    const options = relayQuery({ client: useDashboardClient(), connectionId, store, fixture: useIsMockClient() });
    const query = useQuery(options);
    const [stored, setStored] = useState<{ connectionId: string; relay: WakeRelayDto | null } | null>(null);

    useEffect(() => {
        let cancelled = false;
        setStored(null);

        if (connectionId !== null) {
            void store.load(connectionId).then((relay) => {
                if (!cancelled) {
                    setStored({ connectionId, relay });
                }
            });
        }

        return () => {
            cancelled = true;
        };
    }, [connectionId, store]);

    const storedLoaded = connectionId === null || stored?.connectionId === connectionId;
    const fallback = stored?.connectionId === connectionId ? stored.relay : null;
    // A query that does not run (a chosen Mac on the fixture client) stays pending forever; only the stored copy waits.
    const asking = options.enabled !== false && query.isPending;
    return {
        relay: query.data ?? fallback,
        fromMac: query.data !== undefined,
        isPending: (asking || !storedLoaded) && !fallback,
    };
}

/**
 * The wait after a wake was sent at `sentAt`: `waiting` until a timer reaches the deadline, then `expired`. A timer
 * ends it, not a render: a health poll that keeps failing changes nothing the screen reads, so a deadline checked
 * only during render could keep the screen at "Waking…" and keep polling forever.
 */
export function useWakeDeadline(sentAt: number | null, patienceMs: number = WAKE_PATIENCE_MS) {
    const [expiredFor, setExpiredFor] = useState<number | null>(null);

    useEffect(() => {
        if (sentAt === null) {
            return;
        }

        const timer = setTimeout(() => setExpiredFor(sentAt), Math.max(0, sentAt + patienceMs - Date.now()));
        return () => clearTimeout(timer);
    }, [sentAt, patienceMs]);

    const expired = sentAt !== null && expiredFor === sentAt;
    return { waiting: sentAt !== null && !expired, expired };
}

/** Whether the Mac answers; polled while `watching` (after a wake was sent). */
export function useMacHealth(watching: boolean) {
    return useQuery({ ...healthQuery(useDashboardClient()), refetchInterval: watching ? HEALTH_INTERVAL_MS : false });
}

export function useSendWake() {
    return useMutation({ mutationFn: (relay: WakeRelayDto | null) => sendWake(relay) });
}
