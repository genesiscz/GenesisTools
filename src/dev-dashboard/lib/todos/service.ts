import { MacReminders, ReminderPriority } from "@app/utils/macos/apple-reminders";
import type { TodoPriority, TodosResult } from "./types";

export function mapPriority(level: TodoPriority): number {
    return ReminderPriority[level];
}

export async function listTodos(listName: string): Promise<TodosResult> {
    await MacReminders.ensureAuthorized();
    const [lists, reminders] = await Promise.all([
        MacReminders.listLists(),
        MacReminders.listReminders(listName, { includeCompleted: false }),
    ]);

    return { lists, reminders };
}

export async function addTodo(opts: {
    title: string;
    listName: string;
    due?: string;
    priority?: TodoPriority;
    notes?: string;
}): Promise<{ reminderId: string }> {
    let dueDate: Date | undefined;
    if (opts.due) {
        dueDate = new Date(opts.due);
        if (Number.isNaN(dueDate.getTime())) {
            throw new Error(`Invalid due date: ${opts.due}`);
        }
    }

    const priority = opts.priority ? mapPriority(opts.priority) : undefined;
    const reminderId = await MacReminders.createReminder({
        title: opts.title,
        listName: opts.listName,
        dueDate,
        priority,
        notes: opts.notes,
    });

    return { reminderId };
}

export async function completeTodo(reminderId: string): Promise<void> {
    await MacReminders.completeReminder({ reminderId });
}

export async function deleteTodo(reminderId: string): Promise<void> {
    await MacReminders.deleteReminder({ reminderId });
}
