export const moodKeys = {
    all: ["mood"] as const,
    list: (userId: string) => [...moodKeys.all, "list", userId] as const,
};
