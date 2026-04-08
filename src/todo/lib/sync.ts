import { MacCalendar } from "@app/utils/macos/apple-calendar";
import { MacReminders, todoPriorityToApple } from "@app/utils/macos/apple-reminders";
import type { TodoStore } from "./store";
import type { Todo, TodoLink, TodoReminder } from "./types";

export type SyncTarget = "calendar" | "reminders" | "both";

/**
 * Compute alert offsets in minutes from event start for each reminder.
 * E.g. if event is at 21:00 and reminders are at 20:00, 20:30, 20:55,
 * returns [60, 30, 5].
 */
function computeAlertOffsets(eventStartMs: number, reminders: TodoReminder[]): number[] {
    return reminders.map((r) => {
        const diffMinutes = Math.round((eventStartMs - new Date(r.at).getTime()) / 60_000);
        return Math.max(0, diffMinutes);
    });
}

/**
 * Extract the first URL from a todo's links array.
 * Prefers explicit URL links, falls back to GitHub PR/issue URLs.
 */
function extractUrl(links: TodoLink[]): string | undefined {
    const urlLink = links.find((l) => l.type === "url");

    if (urlLink) {
        return urlLink.ref;
    }

    const prLink = links.find((l) => l.type === "pr");

    if (prLink?.repo) {
        return `https://github.com/${prLink.repo}/pull/${prLink.ref}`;
    }

    const issueLink = links.find((l) => l.type === "issue");

    if (issueLink?.repo) {
        return `https://github.com/${issueLink.repo}/issues/${issueLink.ref}`;
    }

    return undefined;
}

/**
 * Sync a todo to Calendar: creates ONE event with multiple alerts.
 * Uses todo.at as event start time, or falls back to the latest reminder time.
 * Returns the event identifier.
 */
async function syncTodoToCalendar(todo: Todo): Promise<string> {
    if (!todo.at && todo.reminders.length === 0) {
        throw new Error("Cannot sync to calendar: no event time (--at) or reminders specified");
    }

    const eventStartMs = todo.at
        ? new Date(todo.at).getTime()
        : Math.max(...todo.reminders.map((r) => new Date(r.at).getTime()));

    const eventStart = new Date(eventStartMs);
    const alerts = computeAlertOffsets(eventStartMs, todo.reminders);
    const url = extractUrl(todo.links);

    return MacCalendar.createEvent({
        title: todo.title,
        notes: todo.description ?? `Todo: ${todo.id}`,
        startDate: eventStart,
        alerts,
        url,
    });
}

/**
 * Sync a todo to Reminders: creates ONE reminder entry.
 * Uses the first reminder's time as the due date.
 * Returns the reminder identifier.
 */
async function syncTodoToReminders(todo: Todo): Promise<string> {
    const firstUnsynced = todo.reminders.find((r) => !r.synced);
    const dueDate = firstUnsynced ? new Date(firstUnsynced.at) : undefined;
    const url = extractUrl(todo.links);

    return MacReminders.createReminder({
        title: todo.title,
        notes: todo.description ?? `Todo: ${todo.id}`,
        dueDate,
        priority: todoPriorityToApple(todo.priority),
        url,
    });
}

/**
 * Sync a todo's reminders to Calendar and/or Reminders.app.
 * Calendar: creates ONE event with all reminders as alert offsets.
 * Reminders: creates ONE reminder entry.
 * Performs a single store.update at the end regardless of target.
 * Returns the number of items synced.
 */
export async function syncTodo(options: { store: TodoStore; todo: Todo; target: SyncTarget }): Promise<number> {
    const { store, todo, target } = options;
    let totalSynced = 0;
    let updatedReminders = [...todo.reminders];
    let changed = false;

    if (target === "calendar" || target === "both") {
        const alreadySynced = updatedReminders.some((r) => r.synced === "calendar" && r.syncId);

        if (!alreadySynced && updatedReminders.length > 0) {
            const eventId = await syncTodoToCalendar(todo);

            updatedReminders = updatedReminders.map((r) => ({
                ...r,
                synced: "calendar" as const,
                syncId: eventId,
            }));
            changed = true;
            totalSynced++;
        }
    }

    if (target === "reminders" || target === "both") {
        const alreadySynced = updatedReminders.some((r) => r.synced === "reminders" && r.syncId);

        if (!alreadySynced) {
            const reminderId = await syncTodoToReminders({ ...todo, reminders: updatedReminders });

            if (updatedReminders.length > 0) {
                updatedReminders = updatedReminders.map((r, i) => {
                    if (i === 0) {
                        return { ...r, synced: "reminders" as const, syncId: reminderId };
                    }

                    return r;
                });
            }

            changed = true;
            totalSynced++;
        }
    }

    if (changed) {
        await store.update(todo.id, { reminders: updatedReminders });
    }

    return totalSynced;
}
