import type { DarwinKit } from "@genesiscz/darwinkit";

import { getDarwinKit } from "./darwinkit";

// ── DarwinKit Reminders types ───────────────────────────────────────
// These types will be exported from @genesiscz/darwinkit once the
// reminders namespace ships. Defined locally until then.

export interface ReminderListInfo {
    identifier: string;
    title: string;
    color: string;
    source: string;
}

export interface ReminderInfo {
    identifier: string;
    title: string;
    is_completed: boolean;
    completion_date?: string;
    due_date?: string;
    start_date?: string;
    priority: number;
    notes?: string;
    url?: string;
    list_identifier: string;
    list_title: string;
    has_alarms: boolean;
    external_identifier?: string;
}

export interface RemindersSaveResult {
    success: boolean;
    identifier?: string;
    error?: string;
}

interface RemindersOkResult {
    ok: boolean;
}

// ── Helper for calling reminders methods on DarwinKit ───────────────

type RemindersMethod =
    | "reminders.authorized"
    | "reminders.lists"
    | "reminders.items"
    | "reminders.save_item"
    | "reminders.remove_item"
    | "reminders.complete_item"
    | "reminders.incomplete"
    | "reminders.completed";

async function callReminders<T>(
    dk: DarwinKit,
    method: RemindersMethod,
    params: Record<string, unknown> = {}
): Promise<T> {
    const callFn = dk.call.bind(dk) as (method: string, params: Record<string, unknown>) => Promise<unknown>;
    return callFn(method, params) as T;
}

// ── Priority mapping ────────────────────────────────────────────────

const PRIORITY_MAP: Record<string, number> = {
    critical: 1,
    high: 5,
    medium: 9,
    low: 0,
};

export function todoPriorityToApple(priority: "critical" | "high" | "medium" | "low"): number {
    return PRIORITY_MAP[priority];
}

// ── MacReminders class ──────────────────────────────────────────────

export class MacReminders {
    static async ensureAuthorized(): Promise<void> {
        const dk = getDarwinKit();
        const auth = await callReminders<{ status: string; authorized: boolean }>(dk, "reminders.authorized");

        if (!auth.authorized) {
            throw new Error(
                `Reminders access not authorized (status: ${auth.status}). Grant access in System Settings > Privacy & Security > Reminders.`
            );
        }
    }

    static async listLists(): Promise<ReminderListInfo[]> {
        const dk = getDarwinKit();
        const result = await callReminders<{ lists: ReminderListInfo[] }>(dk, "reminders.lists");
        return result.lists;
    }

    static async listReminders(listName?: string, options?: { includeCompleted?: boolean }): Promise<ReminderInfo[]> {
        const dk = getDarwinKit();
        let listIdentifiers: string[] | undefined;

        if (listName) {
            const lists = await MacReminders.listLists();
            const match = lists.find((l) => l.title === listName);

            if (match) {
                listIdentifiers = [match.identifier];
            }
        }

        if (options?.includeCompleted) {
            const result = await callReminders<{ reminders: ReminderInfo[] }>(dk, "reminders.items", {
                list_identifiers: listIdentifiers,
            });
            return result.reminders;
        }

        const result = await callReminders<{ reminders: ReminderInfo[] }>(dk, "reminders.incomplete", {
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

        const result = await callReminders<RemindersSaveResult>(dk, "reminders.save_item", {
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
            await callReminders<ReminderInfo>(dk, "reminders.complete_item", {
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
            const result = await callReminders<RemindersOkResult>(dk, "reminders.remove_item", {
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

        // DarwinKit doesn't have a dedicated createList method — use saveItem
        // to trigger list creation, or rely on the reminders.lists namespace.
        // For now, create a dummy reminder and delete it to force list creation.
        // This is a workaround until DarwinKit adds saveList support.
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

// ── Backward-compatible named exports ───────────────────────────────

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
