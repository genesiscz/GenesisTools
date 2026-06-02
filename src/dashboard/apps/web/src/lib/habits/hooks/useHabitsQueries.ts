import { useMutation, useQuery } from "@tanstack/react-query";
import { useInvalidateAndBroadcast } from "@/lib/sync/useBroadcastInvalidation";
import { HABITS_SYNC_CHANNEL } from "../habits-channel";
import { archiveHabit, type CreateHabitInput, createHabit, listHabits, toggleHabitToday } from "../habits.server";
import { habitKeys } from "../habits-keys";

const queryConfig = {
    staleTime: 30_000,
    refetchOnWindowFocus: true,
};

// ============================================
// Query
// ============================================

export function useHabitsQuery(userId: string | null) {
    return useQuery({
        queryKey: habitKeys.list(userId ?? ""),
        queryFn: () => listHabits(),
        enabled: !!userId,
        ...queryConfig,
    });
}

// ============================================
// Mutations
// ============================================

export function useCreateHabitMutation() {
    const invalidate = useInvalidateAndBroadcast(HABITS_SYNC_CHANNEL);

    return useMutation({
        mutationFn: (data: CreateHabitInput) => createHabit({ data }),
        onSuccess: () => invalidate(habitKeys.all),
    });
}

export function useToggleHabitMutation() {
    const invalidate = useInvalidateAndBroadcast(HABITS_SYNC_CHANNEL);

    return useMutation({
        mutationFn: (habitId: string) => toggleHabitToday({ data: { habitId } }),
        onSuccess: () => invalidate(habitKeys.all),
    });
}

export function useArchiveHabitMutation() {
    const invalidate = useInvalidateAndBroadcast(HABITS_SYNC_CHANNEL);

    return useMutation({
        mutationFn: (habitId: string) => archiveHabit({ data: { habitId } }),
        onSuccess: () => invalidate(habitKeys.all),
    });
}
