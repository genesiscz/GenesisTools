import type { WatchMuteReceiptDto, WatchSourceId } from "@dd/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useDashboardClient } from "@/api/client-provider";
import { muteWatch, watchingKeys, watchingQuery } from "@/features/watching/queries";

export function useWatching() {
    const focused = useIsFocused();
    const options = watchingQuery(useDashboardClient());
    return useQuery({ ...options, refetchInterval: focused ? options.refetchInterval : false });
}

export function useMuteWatch(onReceipt: (receipt: WatchMuteReceiptDto) => void) {
    const client = useDashboardClient();
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: { source: WatchSourceId; id: string; minutes: number; idempotencyKey: string }) =>
            muteWatch(client, input),
        onSuccess: onReceipt,
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: watchingKeys.list });
        },
    });
}
