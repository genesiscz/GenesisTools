import type { ReminderInfo } from "@app/utils/macos/apple-reminders";
import { formatTable } from "@app/utils/table";

export function formatPriority(priority: number): string {
    if (priority === 1) {
        return "Critical";
    }

    if (priority >= 2 && priority <= 4) {
        return "High";
    }

    if (priority >= 5 && priority <= 6) {
        return "Medium";
    }

    if (priority >= 7 && priority <= 9) {
        return "Low";
    }

    return "None";
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
