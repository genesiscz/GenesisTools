import type { CreateHabitInput, HabitWithStats } from "../habits.server";
import {
    useArchiveHabitMutation,
    useCreateHabitMutation,
    useHabitsQuery,
    useToggleHabitMutation,
} from "./useHabitsQueries";

export function useHabits(userId: string | null) {
    const query = useHabitsQuery(userId);
    const createMut = useCreateHabitMutation();
    const toggleMut = useToggleHabitMutation();
    const archiveMut = useArchiveHabitMutation();

    const habits: HabitWithStats[] = query.data ?? [];
    const loading = query.isLoading;
    const initialized = !loading && query.data !== undefined;

    async function addHabit(input: CreateHabitInput): Promise<boolean> {
        if (!userId) {
            return false;
        }

        const result = await createMut.mutateAsync(input);
        return result.success;
    }

    async function toggleToday(habitId: string): Promise<boolean> {
        if (!userId) {
            return false;
        }

        const result = await toggleMut.mutateAsync(habitId);
        return result.done;
    }

    async function archive(habitId: string): Promise<boolean> {
        if (!userId) {
            return false;
        }

        const result = await archiveMut.mutateAsync(habitId);
        return result.success;
    }

    return {
        habits,
        loading,
        initialized,
        error: query.error,
        addHabit,
        toggleToday,
        archive,
        togglingId: toggleMut.isPending ? toggleMut.variables : null,
    };
}
