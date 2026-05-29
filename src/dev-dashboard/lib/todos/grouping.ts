import type { ReminderInfo } from "@genesiscz/darwinkit";
import { formatReminderPriority } from "@genesiscz/darwinkit";
import type { TodoGroup, TodoGroupBy } from "./types";

interface DateBucket {
    key: string;
    label: string;
    sort: number;
}

function startOfDay(date: Date): Date {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
}

function dateBucket(due?: string): DateBucket {
    if (!due) {
        return { key: "none", label: "No due date", sort: 50 };
    }

    const dueDate = new Date(due);

    if (Number.isNaN(dueDate.getTime())) {
        return { key: "invalid", label: "Invalid date", sort: 51 };
    }

    const now = new Date();
    const today = startOfDay(now);
    const dueDay = startOfDay(dueDate);
    const diffDays = Math.round((dueDay.getTime() - today.getTime()) / 86_400_000);

    if (dueDay.getTime() < today.getTime()) {
        return { key: "overdue", label: "Overdue", sort: 0 };
    }

    if (diffDays === 0) {
        return { key: "today", label: "Today", sort: 10 };
    }

    if (diffDays === 1) {
        return { key: "tomorrow", label: "Tomorrow", sort: 20 };
    }

    if (diffDays <= 7) {
        return { key: "week", label: "This week", sort: 30 };
    }

    if (diffDays <= 30) {
        return { key: "month", label: "This month", sort: 40 };
    }

    return { key: "later", label: "Later", sort: 45 };
}

function priorityBucket(priority: number): { key: string; label: string; sort: number } {
    const label = formatReminderPriority(priority);
    const sort = priority === 1 ? 0 : priority === 5 ? 1 : priority === 9 ? 2 : priority === 0 ? 3 : 4;

    return { key: `p-${priority}`, label, sort };
}

function sortReminders(items: ReminderInfo[]): ReminderInfo[] {
    return [...items].sort((a, b) => {
        const aDue = a.due_date ? new Date(a.due_date).getTime() : Number.POSITIVE_INFINITY;
        const bDue = b.due_date ? new Date(b.due_date).getTime() : Number.POSITIVE_INFINITY;

        if (aDue !== bDue) {
            return aDue - bDue;
        }

        if (a.priority !== b.priority) {
            return a.priority - b.priority;
        }

        return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    });
}

function buildGroups(
    reminders: ReminderInfo[],
    keyFn: (reminder: ReminderInfo) => { key: string; label: string; sort: number }
): TodoGroup[] {
    const map = new Map<string, { label: string; sort: number; items: ReminderInfo[] }>();

    for (const reminder of reminders) {
        const bucket = keyFn(reminder);
        const existing = map.get(bucket.key);

        if (existing) {
            existing.items.push(reminder);
        } else {
            map.set(bucket.key, { label: bucket.label, sort: bucket.sort, items: [reminder] });
        }
    }

    return [...map.entries()]
        .sort(([, a], [, b]) => a.sort - b.sort || a.label.localeCompare(b.label))
        .map(([key, value]) => ({
            key,
            label: value.label,
            items: sortReminders(value.items),
        }));
}

export function groupReminders(reminders: ReminderInfo[], groupBy: TodoGroupBy): TodoGroup[] {
    if (groupBy === "bucket") {
        return buildGroups(reminders, (r) => ({
            key: r.list_identifier,
            label: r.list_title || "Unknown list",
            sort: 0,
        }));
    }

    if (groupBy === "priority") {
        return buildGroups(reminders, (r) => priorityBucket(r.priority));
    }

    if (groupBy === "date-priority") {
        const dateGroups = buildGroups(reminders, (r) => dateBucket(r.due_date));
        const nested: TodoGroup[] = [];

        for (const dateGroup of dateGroups) {
            const priorityGroups = buildGroups(dateGroup.items, (r) => priorityBucket(r.priority));

            for (const priorityGroup of priorityGroups) {
                nested.push({
                    key: `${dateGroup.key}:${priorityGroup.key}`,
                    label: `${dateGroup.label} · ${priorityGroup.label}`,
                    items: priorityGroup.items,
                });
            }
        }

        return nested;
    }

    return buildGroups(reminders, (r) => dateBucket(r.due_date));
}
