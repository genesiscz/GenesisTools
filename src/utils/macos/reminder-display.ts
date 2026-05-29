import { formatClock } from "@app/utils/format";
import { formatReminderPriority } from "@app/utils/macos/reminder-priority";
import type { ReminderAlarmInfo, ReminderInfo } from "@genesiscz/darwinkit";

export function notesPreview(notes?: string, maxLen = 120): string | null {
    if (!notes) {
        return null;
    }

    const collapsed = notes.replace(/\s+/g, " ").trim();

    if (!collapsed) {
        return null;
    }

    if (collapsed.length <= maxLen) {
        return collapsed;
    }

    return `${collapsed.slice(0, maxLen - 1)}…`;
}

export function priorityLabel(priority: number): string {
    return formatReminderPriority(priority);
}

export function formatReminderDue(due?: string): string | null {
    if (!due) {
        return null;
    }

    return formatClock(due, { date: "short" });
}

export function isReminderOverdue(due?: string, completed?: boolean): boolean {
    if (!due || completed) {
        return false;
    }

    return new Date(due).getTime() < Date.now();
}

export function formatAlarmSummary(alarm: ReminderAlarmInfo): string {
    if (alarm.type === "location" && alarm.location) {
        const proximity = alarm.proximity === "enter" ? "arrive" : alarm.proximity === "leave" ? "leave" : "near";
        return `Location · ${proximity} · ${alarm.location.title}`;
    }

    if (alarm.absolute_date) {
        return `Alarm · ${formatClock(alarm.absolute_date, { date: "short" })}`;
    }

    if (alarm.relative_offset !== undefined) {
        return `Alarm · ${alarm.relative_offset}s offset`;
    }

    return "Alarm";
}

export function reminderDetailFields(reminder: ReminderInfo): { label: string; value: string }[] {
    const fields: { label: string; value: string }[] = [
        { label: "List", value: reminder.list_title },
        { label: "Priority", value: priorityLabel(reminder.priority) },
    ];

    if (reminder.due_date) {
        fields.push({ label: "Due", value: formatClock(reminder.due_date, { date: "short" }) });
    }

    if (reminder.start_date) {
        fields.push({ label: "Start", value: formatClock(reminder.start_date, { date: "short" }) });
    }

    if (reminder.completion_date) {
        fields.push({ label: "Completed", value: formatClock(reminder.completion_date, { date: "short" }) });
    }

    if (reminder.notes?.trim()) {
        fields.push({ label: "Notes", value: reminder.notes.trim() });
    }

    if (reminder.url?.trim()) {
        fields.push({ label: "URL", value: reminder.url.trim() });
    }

    if (reminder.is_flagged) {
        fields.push({ label: "Flagged", value: "Yes" });
    }

    if (reminder.has_alarms && reminder.alarms.length > 0) {
        for (const alarm of reminder.alarms) {
            fields.push({ label: "Alarm", value: formatAlarmSummary(alarm) });
        }
    }

    if (reminder.external_identifier) {
        fields.push({ label: "External ID", value: reminder.external_identifier });
    }

    fields.push({ label: "Reminder ID", value: reminder.identifier });

    return fields;
}
