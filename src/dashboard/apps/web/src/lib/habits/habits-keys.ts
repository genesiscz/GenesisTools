export const habitKeys = {
    all: ["habits"] as const,
    list: (userId: string) => [...habitKeys.all, "list", userId] as const,
};
