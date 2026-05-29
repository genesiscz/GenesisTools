import {
    MacReminders,
    ReminderPriority,
    type RemindersAuthResult,
    RemindersPermissionError,
} from "@app/utils/macos/apple-reminders";
import type { TodoPriority, TodosResult } from "./types";

export { RemindersPermissionError };

export async function requestTodosAccess(): Promise<RemindersAuthResult> {
    return MacReminders.requestAccess();
}

export function mapPriority(level: TodoPriority): number {
    return ReminderPriority[level];
}

export async function listTodos(
    listNames: string | string[],
    options?: { includeCompleted?: boolean }
): Promise<TodosResult> {
    const includeCompleted = options?.includeCompleted ?? false;
    const names = Array.isArray(listNames) ? listNames : [listNames];
    const listFilter = names.length > 0 ? names : undefined;

    await MacReminders.ensureAuthorized({ requestIfNeeded: true });
    const [lists, reminders] = await Promise.all([
        MacReminders.listLists(),
        MacReminders.listReminders(listFilter, { includeCompleted }),
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
