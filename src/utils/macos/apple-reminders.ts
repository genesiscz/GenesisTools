import logger from "@app/logger";
import type { ReminderInfo, ReminderListInfo } from "@genesiscz/darwinkit";
import { ReminderPriority } from "@genesiscz/darwinkit";
import { getDarwinKit } from "./darwinkit";

export type { ReminderInfo, ReminderListInfo };
export { ReminderPriority };

export function todoPriorityToApple(priority: "critical" | "high" | "medium" | "low"): number {
    return ReminderPriority[priority === "critical" ? "high" : priority];
}

export class MacReminders {
    static async ensureAuthorized(): Promise<void> {
        const dk = getDarwinKit();
        const auth = await dk.reminders.authorized();

        if (!auth.authorized) {
            throw new Error(
                `Reminders access not authorized (status: ${auth.status}). Grant access in System Settings > Privacy & Security > Reminders.`
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
        const listId = await MacReminders.ensureListExists(options.listName ?? "GenesisTools");

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

    static async completeReminder(options: { reminderId: string }): Promise<boolean> {
        const dk = getDarwinKit();

        try {
            await dk.reminders.completeItem({
                identifier: options.reminderId,
            });
            return true;
        } catch (error) {
            logger.error({ error, reminderId: options.reminderId }, "Failed to complete reminder");
            return false;
        }
    }

    static async deleteReminder(options: { reminderId: string }): Promise<boolean> {
        const dk = getDarwinKit();

        try {
            const result = await dk.reminders.removeItem({
                identifier: options.reminderId,
            });
            return result.ok;
        } catch (error) {
            logger.error({ error, reminderId: options.reminderId }, "Failed to delete reminder");
            return false;
        }
    }

    static async ensureListExists(name: string, lists?: ReminderListInfo[]): Promise<string> {
        const allLists = lists ?? (await MacReminders.listLists());
        const existing = allLists.find((l) => l.title === name);

        if (existing) {
            return existing.identifier;
        }

        throw new Error(`Reminder list "${name}" does not exist. Create it manually in Reminders.app.`);
    }
}
