import type {
    CreateGoalInput,
    CreateKeyResultInput,
    GoalRow,
    GoalStatus,
    UpdateGoalInput,
    UpdateKeyResultInput,
} from "../goals.server";
import {
    useCreateGoalMutation,
    useCreateKeyResultMutation,
    useDeleteGoalMutation,
    useDeleteKeyResultMutation,
    useGoalsQuery,
    useUpdateGoalMutation,
    useUpdateKeyResultMutation,
} from "./useGoalsQueries";

export function useGoals(userId: string | null) {
    const query = useGoalsQuery(userId);
    const createMut = useCreateGoalMutation(userId);
    const updateMut = useUpdateGoalMutation(userId);
    const deleteMut = useDeleteGoalMutation(userId);
    const createKrMut = useCreateKeyResultMutation(userId);
    const updateKrMut = useUpdateKeyResultMutation(userId);
    const deleteKrMut = useDeleteKeyResultMutation(userId);

    const goals: GoalRow[] = query.data ?? [];
    const loading = query.isLoading;
    const initialized = !loading && query.data !== undefined;

    async function addGoal(input: CreateGoalInput): Promise<GoalRow | null> {
        if (!userId) {
            return null;
        }

        return createMut.mutateAsync(input);
    }

    async function patchGoal(id: string, patch: UpdateGoalInput["patch"]): Promise<boolean> {
        if (!userId) {
            return false;
        }

        const result = await updateMut.mutateAsync({ id, patch });
        return result.success;
    }

    async function setStatus(id: string, status: GoalStatus): Promise<boolean> {
        return patchGoal(id, { status });
    }

    async function removeGoal(id: string): Promise<boolean> {
        if (!userId) {
            return false;
        }

        const result = await deleteMut.mutateAsync(id);
        return result.success;
    }

    async function addKeyResult(input: CreateKeyResultInput): Promise<boolean> {
        if (!userId) {
            return false;
        }

        await createKrMut.mutateAsync(input);
        return true;
    }

    async function patchKeyResult(id: string, patch: UpdateKeyResultInput["patch"]): Promise<boolean> {
        if (!userId) {
            return false;
        }

        await updateKrMut.mutateAsync({ id, patch });
        return true;
    }

    async function removeKeyResult(id: string): Promise<boolean> {
        if (!userId) {
            return false;
        }

        const result = await deleteKrMut.mutateAsync(id);
        return result.success;
    }

    return {
        goals,
        loading,
        initialized,
        error: query.error,
        addGoal,
        patchGoal,
        setStatus,
        removeGoal,
        addKeyResult,
        patchKeyResult,
        removeKeyResult,
        creating: createMut.isPending,
        savingKr: createKrMut.isPending || updateKrMut.isPending,
    };
}
