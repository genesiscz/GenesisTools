import type { ReminderInfo, ReminderListInfo } from "@genesiscz/darwinkit";
import type { ReminderGroup, ReminderGroupBy } from "@genesiscz/utils/grouping/reminder-groups";
import type { ReminderTodoPriority } from "@genesiscz/utils/macos/reminder-priority";

export type TodoPriority = ReminderTodoPriority;

export type TodoStatusFilter = "active" | "done" | "all";

export type TodoGroupBy = ReminderGroupBy;

export type TodoGroup = ReminderGroup;

export interface TodosResult {
    lists: ReminderListInfo[];
    reminders: ReminderInfo[];
}

export type { ReminderInfo, ReminderListInfo };
