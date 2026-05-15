export const notesKeys = {
    all: ["notes"] as const,
    list: (userId: string) => [...notesKeys.all, "list", userId] as const,
    detail: (id: string) => [...notesKeys.all, "detail", id] as const,
};
