import type { ReminderInfo, ReminderListInfo } from "@genesiscz/darwinkit";

export type TodoPriority = "none" | "low" | "medium" | "high";

export interface TodosResult {
    lists: ReminderListInfo[];
    reminders: ReminderInfo[];
}

export type { ReminderInfo, ReminderListInfo };
