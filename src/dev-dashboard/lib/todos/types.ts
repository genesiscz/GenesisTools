import type { ReminderGroup, ReminderGroupBy } from "@app/utils/grouping/reminder-groups";
import type { ReminderTodoPriority } from "@app/utils/macos/reminder-priority";
import type { ReminderInfo, ReminderListInfo } from "@genesiscz/darwinkit";

export type TodoPriority = ReminderTodoPriority;

export type TodoStatusFilter = "active" | "done" | "all";

export type TodoGroupBy = ReminderGroupBy;

export type TodoGroup = ReminderGroup;

export interface TodosResult {
    lists: ReminderListInfo[];
    reminders: ReminderInfo[];
}

export type { ReminderInfo, ReminderListInfo };
