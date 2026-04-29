import { MacCalendar } from "@app/utils/macos/apple-calendar";
import { MacReminders, todoPriorityToApple } from "@app/utils/macos/apple-reminders";
import type { TodoStore } from "./store";
import type { Todo, TodoLink, TodoReminder } from "./types";

export type SyncTarget = "calendar" | "reminders" | "both";

export type SyncOutcome = { ok: true; alreadySynced?: boolean } | { ok: false; error: Error };

export interface SyncResult {
    calendar?: SyncOutcome;
    reminders?: SyncOutcome;
}

export function syncSucceeded(result: SyncResult): boolean {
    if (result.calendar && !result.calendar.ok) {
        return false;
    }

    if (result.reminders && !result.reminders.ok) {
        return false;
    }

    return true;
}

export function countSynced(result: SyncResult): number {
    let n = 0;

    if (result.calendar?.ok && !result.calendar.alreadySynced) {
        n++;
    }

    if (result.reminders?.ok && !result.reminders.alreadySynced) {
        n++;
    }

    return n;
}

export function describeSyncFailures(result: SyncResult): string[] {
    const lines: string[] = [];

    if (result.calendar && !result.calendar.ok) {
        lines.push(`calendar: ${result.calendar.error.message}`);
    }

    if (result.reminders && !result.reminders.ok) {
        lines.push(`reminders: ${result.reminders.error.message}`);
    }

    return lines;
}

function computeAlertOffsets(eventStartMs: number, reminders: TodoReminder[]): number[] {
    return reminders.map((r) => {
        const diffMinutes = Math.round((eventStartMs - new Date(r.at).getTime()) / 60_000);
        return Math.max(0, diffMinutes);
    });
}

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
 * Returns a SyncResult with per-target outcomes — failures (e.g. DarwinkitTimeoutError,
 * DarwinkitCrashError) are captured per-target instead of throwing, so the caller can
 * decide how to surface them and which targets still succeeded.
 */
export async function syncTodo(options: { store: TodoStore; todo: Todo; target: SyncTarget }): Promise<SyncResult> {
    const { store, todo, target } = options;
    const result: SyncResult = {};
    let updatedReminders = [...todo.reminders];
    let changed = false;

    if (target === "calendar" || target === "both") {
        const alreadySynced = updatedReminders.some((r) => r.synced === "calendar" && r.syncId);

        if (alreadySynced || updatedReminders.length === 0) {
            result.calendar = { ok: true, alreadySynced: true };
        } else {
            try {
                const eventId = await syncTodoToCalendar(todo);
                updatedReminders = updatedReminders.map((r) => ({
                    ...r,
                    synced: "calendar" as const,
                    syncId: eventId,
                }));
                changed = true;
                result.calendar = { ok: true };
            } catch (error) {
                result.calendar = { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
            }
        }
    }

    if (target === "reminders" || target === "both") {
        const alreadySynced = updatedReminders.some((r) => r.synced === "reminders" && r.syncId);

        if (alreadySynced) {
            result.reminders = { ok: true, alreadySynced: true };
        } else {
            try {
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
                result.reminders = { ok: true };
            } catch (error) {
                result.reminders = {
                    ok: false,
                    error: error instanceof Error ? error : new Error(String(error)),
                };
            }
        }
    }

    if (changed) {
        await store.update(todo.id, { reminders: updatedReminders });
    }

    return result;
}
