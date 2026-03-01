import type { TelegramHistoryStore } from "./TelegramHistoryStore";

export interface PlannedSyncRange {
    since: Date;
    until: Date;
    source: "query" | "full" | "incremental";
}

export class SyncRangePlanner {
    planQueryBackfill(store: TelegramHistoryStore, chatId: string, since: Date, until: Date): PlannedSyncRange[] {
        const missing = store.getMissingSegments(chatId, since, until);

        return missing.map((range) => ({
            since: new Date(range.sinceUnix * 1000),
            until: new Date(range.untilUnix * 1000),
            source: "query" as const,
        }));
    }

    planIncremental(lastSyncedId: number | null): PlannedSyncRange {
        if (lastSyncedId === null) {
            return {
                since: new Date(0),
                until: new Date(),
                source: "full",
            };
        }

        return {
            since: new Date(0),
            until: new Date(),
            source: "incremental",
        };
    }
}

export const syncRangePlanner = new SyncRangePlanner();
