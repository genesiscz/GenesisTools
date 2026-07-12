export const goalKeys = {
    all: ["goals"] as const,
    list: (userId: string) => [...goalKeys.all, "list", userId] as const,
};
