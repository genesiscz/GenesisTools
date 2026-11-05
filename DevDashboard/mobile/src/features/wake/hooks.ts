import type { WakeRelayDto } from "@dd/contract";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import { useDashboardClient } from "@/api/client-provider";
import { HEALTH_INTERVAL_MS, healthQuery, relayQuery, sendWake } from "@/features/wake/queries";
import { createRelayStore, type RelayStore } from "@/features/wake/relay-store";
import { useConnectionStore } from "@/state/connection-store";

const secureRelayStore = createRelayStore(SecureStore);

/** The relay from the Mac while it answers, else the copy stored the last time it did. */
export function useWakeRelay(store: RelayStore = secureRelayStore): {
    relay: WakeRelayDto | null;
    fromMac: boolean;
    isPending: boolean;
} {
    const connectionId = useConnectionStore((s) => s.activeId);
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

/** Whether the Mac answers; polled while `watching` (after a wake was sent). */
export function useMacHealth(watching: boolean) {
    return useQuery({ ...healthQuery(useDashboardClient()), refetchInterval: watching ? HEALTH_INTERVAL_MS : false });
}

export function useSendWake() {
    return useMutation({ mutationFn: (relay: WakeRelayDto | null) => sendWake(relay) });
}
