import type { ReminderInfo } from "@app/utils/macos/apple-reminders";
import { formatTable } from "@app/utils/table";

export function formatPriority(priority: number): string {
    switch (priority) {
        case 1:
            return "Critical";
        case 5:
            return "Medium";
        case 9:
            return "Low";
        default:
            return "None";
    }
}

export function formatDueDate(iso?: string): string {
    if (!iso) {
        return "";
    }

    const d = new Date(iso);
    return d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

export function formatRemindersTable(reminders: ReminderInfo[]): string {
    const rows = reminders.map((r) => [
        r.title,
        formatDueDate(r.due_date),
        formatPriority(r.priority),
        r.is_completed ? "Yes" : "No",
        r.list_title,
    ]);

    return formatTable(rows, ["Title", "Due Date", "Priority", "Completed", "List"]);
}
