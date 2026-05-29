import type { ReminderInfo, ReminderListInfo } from "@genesiscz/darwinkit";

export type TodoPriority = "none" | "low" | "medium" | "high";

export type TodoStatusFilter = "active" | "done" | "all";

export type TodoGroupBy = "date" | "date-priority" | "priority" | "bucket";

export interface TodoGroup {
    key: string;
    label: string;
    items: ReminderInfo[];
}

export interface TodosResult {
    lists: ReminderListInfo[];
    reminders: ReminderInfo[];
}

export type { ReminderInfo, ReminderListInfo };
