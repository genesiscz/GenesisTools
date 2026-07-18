import { formatReminderPriority } from "@genesiscz/darwinkit";
import type { ReminderInfo } from "@genesiscz/utils/macos/apple-reminders";
import { formatTable } from "@genesiscz/utils/table";
import { formatDateTime } from "../calendar/format";

export function formatDueDate(iso?: string): string {
    if (!iso) {
        return "";
    }

    return formatDateTime(iso);
}

export function formatRemindersTable(reminders: ReminderInfo[]): string {
    const rows = reminders.map((r) => [
        r.title,
        formatDueDate(r.due_date),
        formatReminderPriority(r.priority),
        r.is_completed ? "Yes" : "No",
        r.list_title,
    ]);

    return formatTable(rows, ["Title", "Due Date", "Priority", "Completed", "List"]);
}
