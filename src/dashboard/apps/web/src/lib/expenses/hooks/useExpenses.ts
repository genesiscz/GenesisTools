import { useMutation, useQuery } from "@tanstack/react-query";
import { useInvalidateAndBroadcast } from "@/lib/sync/useBroadcastInvalidation";
import {
    type CreateExpenseInput,
    createExpense,
    deleteExpense,
    type ExpenseRow,
    listExpenses,
} from "../expenses.server";
import { expenseKeys } from "../expenses-keys";

export const EXPENSES_SYNC_CHANNEL = "expenses_sync_channel";

export function useExpenses(userId: string | null) {
    const invalidate = useInvalidateAndBroadcast(EXPENSES_SYNC_CHANNEL);

    const query = useQuery({
        queryKey: expenseKeys.list(userId ?? ""),
        queryFn: () => listExpenses(),
        enabled: !!userId,
        staleTime: 30_000,
        refetchOnWindowFocus: true,
    });

    const createMut = useMutation({
        mutationFn: (data: CreateExpenseInput) => createExpense({ data }),
        onSuccess: () => invalidate(expenseKeys.all),
    });

    const deleteMut = useMutation({
        mutationFn: (id: string) => deleteExpense({ data: { id } }),
        onSuccess: () => invalidate(expenseKeys.all),
    });

    const list: ExpenseRow[] = query.data ?? [];
    const loading = query.isLoading;
    const initialized = !loading && query.data !== undefined;

    async function addExpense(input: CreateExpenseInput): Promise<ExpenseRow | null> {
        if (!userId) {
            return null;
        }

        return createMut.mutateAsync(input);
    }

    async function removeExpense(id: string): Promise<boolean> {
        if (!userId) {
            return false;
        }

        const result = await deleteMut.mutateAsync(id);
        return result.success;
    }

    return {
        expenses: list,
        loading,
        initialized,
        error: query.error,
        addExpense,
        removeExpense,
        creating: createMut.isPending,
        deletingId: deleteMut.isPending ? deleteMut.variables : null,
    };
}
