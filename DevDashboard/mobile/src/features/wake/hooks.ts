import type { WakeRelayDto } from "@dd/contract";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import { useDashboardClient, useDashboardConnectionId } from "@/api/client-provider";
import { HEALTH_INTERVAL_MS, healthQuery, relayQuery, sendWake, WAKE_PATIENCE_MS } from "@/features/wake/queries";
import { createRelayStore, type RelayStore } from "@/features/wake/relay-store";

const secureRelayStore = createRelayStore(SecureStore);

/** The relay from the Mac while it answers, else the copy stored the last time it did. */
export function useWakeRelay(store: RelayStore = secureRelayStore): {
    relay: WakeRelayDto | null;
    fromMac: boolean;
    isPending: boolean;
} {
    // The relay is stored per Mac only while that Mac's own client answers, never the fixture's.
    const connectionId = useDashboardConnectionId();
    const query = useQuery(relayQuery({ client: useDashboardClient(), connectionId, store }));
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

    const fallback = stored?.connectionId === connectionId ? stored.relay : null;
    return {
        relay: query.data ?? fallback,
        fromMac: query.data !== undefined,
        isPending: query.isPending && !fallback,
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
