export const expenseKeys = {
    all: ["expenses"] as const,
    list: (userId: string) => [...expenseKeys.all, "list", userId] as const,
};
