import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useInvalidateAndBroadcast } from "@/lib/sync/useBroadcastInvalidation";
import {
    type CreateGoalInput,
    type CreateKeyResultInput,
    createGoal,
    createKeyResult,
    deleteGoal,
    deleteKeyResult,
    listGoals,
    type UpdateGoalInput,
    type UpdateKeyResultInput,
    updateGoal,
    updateKeyResult,
} from "../goals.server";
import { goalKeys } from "../goals-keys";

export const GOALS_SYNC_CHANNEL = "goals_sync_channel";

const queryConfig = {
    staleTime: 30_000,
    refetchOnWindowFocus: true,
};

// ============================================
// Queries
// ============================================

export function useGoalsQuery(userId: string | null) {
    return useQuery({
        queryKey: goalKeys.list(userId ?? ""),
        queryFn: () => listGoals(),
        enabled: !!userId,
        ...queryConfig,
    });
}

// ============================================
// Mutations
// ============================================

function useGoalInvalidate(userId: string | null) {
    const queryClient = useQueryClient();
    const broadcast = useInvalidateAndBroadcast(GOALS_SYNC_CHANNEL);

    return () => {
        queryClient.invalidateQueries({ queryKey: goalKeys.list(userId ?? "") });
        broadcast(goalKeys.all);
    };
}

export function useCreateGoalMutation(userId: string | null) {
    const invalidate = useGoalInvalidate(userId);

    return useMutation({
        mutationFn: (data: CreateGoalInput) => createGoal({ data }),
        onSuccess: invalidate,
    });
}

export function useUpdateGoalMutation(userId: string | null) {
    const invalidate = useGoalInvalidate(userId);

    return useMutation({
        mutationFn: (data: UpdateGoalInput) => updateGoal({ data }),
        onSuccess: invalidate,
    });
}

export function useDeleteGoalMutation(userId: string | null) {
    const invalidate = useGoalInvalidate(userId);

    return useMutation({
        mutationFn: (id: string) => deleteGoal({ data: { id } }),
        onSuccess: invalidate,
    });
}

export function useCreateKeyResultMutation(userId: string | null) {
    const invalidate = useGoalInvalidate(userId);

    return useMutation({
        mutationFn: (data: CreateKeyResultInput) => createKeyResult({ data }),
        onSuccess: invalidate,
    });
}

export function useUpdateKeyResultMutation(userId: string | null) {
    const invalidate = useGoalInvalidate(userId);

    return useMutation({
        mutationFn: (data: UpdateKeyResultInput) => updateKeyResult({ data }),
        onSuccess: invalidate,
    });
}

export function useDeleteKeyResultMutation(userId: string | null) {
    const invalidate = useGoalInvalidate(userId);

    return useMutation({
        mutationFn: (id: string) => deleteKeyResult({ data: { id } }),
        onSuccess: invalidate,
    });
}
