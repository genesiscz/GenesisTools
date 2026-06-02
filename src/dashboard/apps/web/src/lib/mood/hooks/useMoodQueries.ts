import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useInvalidateAndBroadcast } from "@/lib/sync/useBroadcastInvalidation";
import { deleteMoodEntry, listMoodEntries, type MoodCheckInInput, upsertMoodEntry } from "../mood.server";
import { moodKeys } from "../mood-keys";

export const MOOD_SYNC_CHANNEL = "mood_sync_channel";

const queryConfig = {
    staleTime: 30_000,
    refetchOnWindowFocus: true,
};

export function useMoodEntriesQuery(userId: string | null) {
    return useQuery({
        queryKey: moodKeys.list(userId ?? ""),
        queryFn: () => listMoodEntries(),
        enabled: !!userId,
        ...queryConfig,
    });
}

export function useUpsertMoodMutation(userId: string | null) {
    const queryClient = useQueryClient();
    const invalidate = useInvalidateAndBroadcast(MOOD_SYNC_CHANNEL);

    return useMutation({
        mutationFn: (data: MoodCheckInInput) => upsertMoodEntry({ data }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: moodKeys.all });
            invalidate(moodKeys.list(userId ?? ""));
        },
    });
}

export function useDeleteMoodMutation(userId: string | null) {
    const queryClient = useQueryClient();
    const invalidate = useInvalidateAndBroadcast(MOOD_SYNC_CHANNEL);

    return useMutation({
        mutationFn: (day: string) => deleteMoodEntry({ data: { day } }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: moodKeys.all });
            invalidate(moodKeys.list(userId ?? ""));
        },
    });
}
