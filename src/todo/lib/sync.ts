import { createCalendarEvent } from "@app/utils/macos/apple-calendar";
import { createReminder, todoPriorityToApple } from "@app/utils/macos/apple-reminders";
import type { TodoStore } from "./store";
import type { Todo, TodoReminder } from "./types";

export type SyncTarget = "calendar" | "reminders" | "both";

function syncReminderToCalendar(todo: Todo, reminder: TodoReminder): string {
    const startDate = new Date(reminder.at);
    const label = reminder.label ?? todo.title;

    return createCalendarEvent({
        title: label,
        notes: todo.description ?? `Todo: ${todo.id}`,
        startDate,
        alerts: [10],
    });
}

function syncTodoToReminders(todo: Todo): string {
    const firstUnsynced = todo.reminders.find((r) => !r.synced);
    const dueDate = firstUnsynced ? new Date(firstUnsynced.at) : undefined;

    return createReminder({
        title: todo.title,
        notes: todo.description ?? `Todo: ${todo.id}`,
        dueDate,
        priority: todoPriorityToApple(todo.priority),
    });
}

/**
 * Sync a todo's reminders to Calendar and/or Reminders.app.
 * Performs a single store.update at the end regardless of target.
 * Returns the number of items synced.
 */
export async function syncTodo(options: { store: TodoStore; todo: Todo; target: SyncTarget }): Promise<number> {
    const { store, todo, target } = options;
    let totalSynced = 0;
    let updatedReminders = [...todo.reminders];
    let changed = false;

    if (target === "calendar" || target === "both") {
        for (let i = 0; i < updatedReminders.length; i++) {
            const reminder = updatedReminders[i];

            if (reminder.synced === "calendar" && reminder.syncId) {
                continue;
            }

            const eventId = syncReminderToCalendar(todo, reminder);
            updatedReminders[i] = { ...reminder, synced: "calendar", syncId: eventId };
            changed = true;
            totalSynced++;
        }
    }

    if (target === "reminders" || target === "both") {
        const alreadySynced = updatedReminders.some((r) => r.synced === "reminders" && r.syncId);

        if (!alreadySynced) {
            const todoWithUpdatedReminders = { ...todo, reminders: updatedReminders };
            const reminderId = syncTodoToReminders(todoWithUpdatedReminders);

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
