import type { WakeRelayDto } from "@dd/contract";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useDashboardClient } from "@/api/client-provider";
import { HEALTH_INTERVAL_MS, healthQuery, relayQuery, sendWake } from "@/features/wake/queries";
import { loadRelay, saveRelay } from "@/features/wake/relay-store";

/** The relay from the Mac while it answers, else the copy stored the last time it did. */
export function useWakeRelay(): { relay: WakeRelayDto | null; fromMac: boolean; isPending: boolean } {
    const query = useQuery(relayQuery(useDashboardClient()));
    const [stored, setStored] = useState<WakeRelayDto | null>(null);

    useEffect(() => {
        void loadRelay().then(setStored);
    }, []);

    useEffect(() => {
        if (query.data) {
            void saveRelay(query.data);
        }
    }, [query.data]);

    return { relay: query.data ?? stored, fromMac: query.data !== undefined, isPending: query.isPending && !stored };
}

/** Whether the Mac answers; polled while `watching` (after a wake was sent). */
export function useMacHealth(watching: boolean) {
    return useQuery({ ...healthQuery(useDashboardClient()), refetchInterval: watching ? HEALTH_INTERVAL_MS : false });
}

export function useSendWake() {
    return useMutation({ mutationFn: (relay: WakeRelayDto | null) => sendWake(relay) });
}
