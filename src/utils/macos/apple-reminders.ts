import type { ReminderInfo, ReminderListInfo } from "@genesiscz/darwinkit";

import { getDarwinKit } from "./darwinkit";

export type { ReminderInfo, ReminderListInfo };

const PRIORITY_MAP: Record<string, number> = {
    critical: 1,
    high: 5,
    medium: 9,
    low: 0,
};

export function todoPriorityToApple(priority: "critical" | "high" | "medium" | "low"): number {
    return PRIORITY_MAP[priority];
}

export class MacReminders {
    static async ensureAuthorized(): Promise<void> {
        const dk = getDarwinKit();
        const auth = await dk.reminders.authorized();

        if (!auth.authorized) {
            throw new Error(
                `Reminders access not authorized (status: ${auth.status}). Grant access in System Settings > Privacy & Security > Reminders.`,
            );
        }
    }

    static async listLists(): Promise<ReminderListInfo[]> {
        const dk = getDarwinKit();
        const result = await dk.reminders.lists();
        return result.lists;
    }

    static async listReminders(listName?: string, options?: { includeCompleted?: boolean }): Promise<ReminderInfo[]> {
        const dk = getDarwinKit();
        let listIdentifiers: string[] | undefined;

        if (listName) {
            const lists = await MacReminders.listLists();
            const match = lists.find((l) => l.title === listName);

            if (!match) {
                return [];
            }

            listIdentifiers = [match.identifier];
        }

        if (options?.includeCompleted) {
            const result = await dk.reminders.items({
                list_identifiers: listIdentifiers,
            });
            return result.reminders;
        }

        const result = await dk.reminders.incomplete({
            list_identifiers: listIdentifiers,
        });
        return result.reminders;
    }

    static async searchReminders(query: string, listName?: string): Promise<ReminderInfo[]> {
        const reminders = await MacReminders.listReminders(listName, { includeCompleted: true });
        const q = query.toLowerCase();
        return reminders.filter((r) => r.title.toLowerCase().includes(q) || r.notes?.toLowerCase().includes(q));
    }

    static async createReminder(options: {
        title: string;
        notes?: string;
        dueDate?: Date;
        priority?: number;
        listName?: string;
        url?: string;
    }): Promise<string> {
        const dk = getDarwinKit();
        const listId = await MacReminders.resolveListId(options.listName ?? "GenesisTools");

        const result = await dk.reminders.saveItem({
            calendar_identifier: listId,
            title: options.title,
            notes: options.notes,
            due_date: options.dueDate?.toISOString(),
            priority: options.priority ?? 0,
            url: options.url,
        });

        if (!result.success || !result.identifier) {
            throw new Error(`Failed to create reminder: ${result.error ?? "unknown error"}`);
        }

        return result.identifier;
    }

    static async completeReminder(options: { reminderId: string; listName?: string }): Promise<boolean> {
        const dk = getDarwinKit();

        try {
            await dk.reminders.completeItem({
                identifier: options.reminderId,
            });
            return true;
        } catch {
            return false;
        }
    }

    static async deleteReminder(options: { reminderId: string; listName?: string }): Promise<boolean> {
        const dk = getDarwinKit();

        try {
            const result = await dk.reminders.removeItem({
                identifier: options.reminderId,
            });
            return result.ok;
        } catch {
            return false;
        }
    }

    static async ensureListExists(name: string): Promise<string> {
        const lists = await MacReminders.listLists();
        const existing = lists.find((l) => l.title === name);

        if (existing) {
            return existing.identifier;
        }

        throw new Error(`Reminder list "${name}" does not exist. Create it manually in Reminders.app.`);
    }

    private static async resolveListId(listName: string): Promise<string> {
        const lists = await MacReminders.listLists();
        const match = lists.find((l) => l.title === listName);

        if (match) {
            return match.identifier;
        }

        return MacReminders.ensureListExists(listName);
    }
}

// Backward-compatible named exports

export function ensureReminderListExists(_name: string): void {
    throw new Error("ensureReminderListExists is no longer synchronous. Use MacReminders.ensureListExists() instead.");
}

export async function createReminder(options: {
    title: string;
    notes?: string;
    dueDate?: Date;
    priority?: number;
    listName?: string;
}): Promise<string> {
    return MacReminders.createReminder(options);
}

export async function completeReminder(options: { reminderId: string; listName?: string }): Promise<boolean> {
    return MacReminders.completeReminder(options);
}

export async function deleteReminder(options: { reminderId: string; listName?: string }): Promise<boolean> {
    return MacReminders.deleteReminder(options);
}
