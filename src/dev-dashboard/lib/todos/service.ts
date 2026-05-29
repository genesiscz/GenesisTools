import {
    MacReminders,
    ReminderPriority,
    type RemindersAuthResult,
    RemindersPermissionError,
} from "@app/utils/macos/apple-reminders";
import type { ReminderListInfo } from "@genesiscz/darwinkit";
import type { TodoPriority, TodosResult } from "./types";

export { RemindersPermissionError };

export function dedupeReminderLists(lists: ReminderListInfo[]): ReminderListInfo[] {
    const seen = new Set<string>();

    return lists.filter((list) => {
        if (seen.has(list.identifier)) {
            return false;
        }

        seen.add(list.identifier);
        return true;
    });
}

export async function requestTodosAccess(): Promise<RemindersAuthResult> {
    return MacReminders.requestAccess();
}

export function mapPriority(level: TodoPriority): number {
    return ReminderPriority[level];
}

export async function listTodos(
    listIds: string | string[],
    options?: { includeCompleted?: boolean }
): Promise<TodosResult> {
    const includeCompleted = options?.includeCompleted ?? false;
    const ids = [...new Set(Array.isArray(listIds) ? listIds : [listIds])].filter(Boolean);

    await MacReminders.ensureAuthorized({ requestIfNeeded: true });
    const lists = dedupeReminderLists(await MacReminders.listLists());

    let fetchIds = ids;

    if (fetchIds.length === 0) {
        const fallback = lists.find((list) => list.title === "GenesisTools") ?? lists[0];

        if (fallback) {
            fetchIds = [fallback.identifier];
        }
    }

    const reminders =
        fetchIds.length > 0
            ? await MacReminders.listReminders(undefined, { includeCompleted, listIdentifiers: fetchIds })
            : [];

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

export async function updateTodo(opts: {
    reminderId: string;
    listIdentifier: string;
    title: string;
    notes?: string;
    due?: string | null;
    priority?: TodoPriority;
    url?: string;
    completed?: boolean;
}): Promise<void> {
    let dueDate: Date | null | undefined;

    if (opts.due === null) {
        dueDate = null;
    } else if (opts.due) {
        dueDate = new Date(opts.due);

        if (Number.isNaN(dueDate.getTime())) {
            throw new Error(`Invalid due date: ${opts.due}`);
        }
    }

    const priority = opts.priority ? mapPriority(opts.priority) : undefined;

    await MacReminders.updateReminder({
        reminderId: opts.reminderId,
        listIdentifier: opts.listIdentifier,
        title: opts.title,
        notes: opts.notes,
        dueDate,
        priority,
        url: opts.url,
        completed: opts.completed,
    });
}
