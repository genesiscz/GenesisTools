export const readingKeys = {
    all: ["reading"] as const,
    list: (userId: string) => [...readingKeys.all, "list", userId] as const,
    highlights: (itemId: string) => [...readingKeys.all, "highlights", itemId] as const,
};

export const READING_SYNC_CHANNEL = "reading_sync_channel";
