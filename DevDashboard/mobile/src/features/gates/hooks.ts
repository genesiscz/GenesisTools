import type { GateRaiseReceiptDto } from "@dd/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useDashboardClient } from "@/api/client-provider";
import { gatesKeys, gatesQuery, raiseGate } from "@/features/gates/queries";

/** What waits on the Mac's Touch ID; polled only while the card is on screen. */
export function useGateLedger() {
    const focused = useIsFocused();
    const options = gatesQuery(useDashboardClient());
    return useQuery({ ...options, refetchInterval: focused ? options.refetchInterval : false });
}

/** Brings a waiting window to the Mac's front, or opens one for an rm request. The answer stays on the Mac. */
export function useRaiseGate(onReceipt: (receipt: GateRaiseReceiptDto) => void) {
    const client = useDashboardClient();
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: { id: string; idempotencyKey: string }) => raiseGate(client, input),
        onSuccess: onReceipt,
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: gatesKeys.ledger });
        },
    });
}
