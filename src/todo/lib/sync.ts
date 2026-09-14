import { MacCalendar } from "@genesiscz/utils/macos/apple-calendar";
import { MacReminders, todoPriorityToApple } from "@genesiscz/utils/macos/apple-reminders";
import type { TodoStore } from "./store";
import type { Todo, TodoLink, TodoReminder } from "./types";

export type SyncTarget = "calendar" | "reminders" | "both";

/**
 * The only store capability a sync needs.
 *
 * Narrow on purpose: the test double implements exactly this, with no cast, so
 * a change to the method's shape is a compile error in the test rather than a
 * runtime surprise. The previous double was `as unknown as TodoStore`, which
 * swallowed the signature entirely — it kept passing `tsgo` while missing the
 * method this function had started calling.
 */
export type SyncStore = Pick<TodoStore, "updateWith">;

/**
 * `id` is the EventKit identifier, and it is REQUIRED on success.
 *
 * It used to be optional, so the printer carried a placeholder fallback and an
 * agent parsing stdout could be handed that placeholder as if it were an event
 * id. A success is only ever reported after the platform confirmed an
 * identifier, so the type now says so and the fallback is gone.
 */
export type SyncOutcome = { ok: true; id: string; alreadySynced?: boolean } | { ok: false; error: Error };

export interface SyncResult {
    calendar?: SyncOutcome;
    reminders?: SyncOutcome;
}

const SYNC_TARGETS = ["calendar", "reminders"] as const;

/**
 * One stdout line per attempted target, always.
 *
 * A sync that printed nothing on the no-op path and wrote its success line to
 * stderr left agents unable to tell "created an EventKit event" from "did
 * nothing" (observed 2026-09-09). Callers print these with `out.println`.
 */
export function describeSyncOutcomes(result: SyncResult, todoId: string): string[] {
    const lines: string[] = [];

    for (const target of SYNC_TARGETS) {
        const outcome = result[target];

        if (!outcome?.ok) {
            continue;
        }

        const verb = outcome.alreadySynced ? "already-synced" : "created";
        lines.push(`SYNC_OK ${target} ${todoId} ${verb} ${outcome.id}`);
    }

    return lines;
}

export interface SyncReport {
    /** The machine result: what exists in EventKit now. */
    stdout: string[];
    /** Diagnostics: one line per target that failed. */
    stderr: string[];
    failed: boolean;
}

/**
 * The single shape every door reports a sync with, so `add --sync-to`,
 * `edit --sync-to` and `sync` cannot drift apart again.
 */
export function buildSyncReport(result: SyncResult, todoId: string): SyncReport {
    const stderr: string[] = [];

    for (const target of SYNC_TARGETS) {
        const outcome = result[target];

        if (outcome && !outcome.ok) {
            stderr.push(`SYNC_FAILED ${target} ${todoId}: ${outcome.error.message}`);
        }
    }

    return {
        stdout: describeSyncOutcomes(result, todoId),
        stderr,
        failed: !syncSucceeded(result),
    };
}

/**
 * Never record a sync the platform did not confirm: `reminders[].synced` is the
 * evidence a calendar event exists, so an empty identifier must fail loudly
 * rather than persist a claim nothing backs.
 */
function assertIdentifier(id: string | undefined, target: (typeof SYNC_TARGETS)[number]): string {
    if (!id) {
        throw new Error(`${target} returned no identifier — nothing was created`);
    }

    return id;
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

/**
 * The epoch this entry points at, or null when it carries no usable time.
 *
 * An entry can exist purely to hold an identifier: a todo with neither `--at`
 * nor a reminder still creates a real Reminders item, and that id needs a home.
 * Reading `at` blindly turns such an anchor into an `Invalid Date`, which then
 * reaches EventKit as a start date instead of failing the guard above it.
 */
function reminderTimeMs(reminder: TodoReminder): number | null {
    if (!reminder.at) {
        return null;
    }

    const ms = new Date(reminder.at).getTime();

    return Number.isNaN(ms) ? null : ms;
}

function computeAlertOffsets(eventStartMs: number, reminders: TodoReminder[]): number[] {
    const offsets: number[] = [];

    for (const reminder of reminders) {
        const ms = reminderTimeMs(reminder);

        if (ms === null) {
            continue;
        }

        offsets.push(Math.max(0, Math.round((eventStartMs - ms) / 60_000)));
    }

    return offsets;
}

/**
 * `reminders[]` is the only place a sync id can be recorded, so a todo created
 * with `--at` and no `--reminder` had nowhere to write one. The old code read
 * that empty list as "already synced" and returned success without calling
 * EventKit at all — the silent no-op behind the 2026-09-09 report.
 *
 * One entry at the event start is materialized instead: the event gets an alert
 * at its start time, and the sync id has a home.
 */
function materializeReminders(todo: Todo): TodoReminder[] {
    if (todo.reminders.length > 0) {
        return [...todo.reminders];
    }

    if (!todo.at) {
        return [];
    }

    return [{ at: todo.at, label: "event start", synced: null }];
}

/**
 * A target owns an entry only once the platform confirmed an identifier for it.
 * A bare `synced` marker with no `syncId` is a half-written record, never
 * ownership, which is why the short-circuit checks use this too.
 */
function ownedBy(reminder: TodoReminder, target: (typeof SYNC_TARGETS)[number]): boolean {
    return reminder.synced === target && Boolean(reminder.syncId);
}

/**
 * The ONE rule for which entry the Reminders item corresponds to.
 *
 * `recordReminderSync` stamps this entry, and `syncTodoToReminders` takes the
 * item's due date from it. They used to disagree: the due date came from the
 * first entry with no `synced` marker AT ALL, so under `--sync-to both` the
 * calendar had already stamped every entry by then and the Reminders item was
 * created with no due date, while `--sync-to reminders` alone gave it one.
 */
function reminderSlotIndex(reminders: TodoReminder[]): number {
    return reminders.findIndex((r) => !ownedBy(r, "calendar"));
}

/**
 * Whether `sync --all` should offer this todo to a target at all.
 *
 * Counting entries rather than TIMED entries would pick up a todo whose only
 * entry is an untimed Reminders anchor, and `--all --to calendar` would then
 * fail the whole run on a todo that was correctly skipped before it was synced.
 */
export function hasSyncableTime(todo: Todo): boolean {
    return Boolean(todo.at) || todo.reminders.some((r) => reminderTimeMs(r) !== null);
}

/**
 * One reminder entry records ONE platform identifier, so neither target may
 * overwrite an entry the other already owns.
 *
 * Both branches used to stamp unconditionally, so `--sync-to both` lost an id
 * whichever way round it ran: the calendar stamped every entry, then the
 * Reminders item overwrote entry 0 and the event id was gone; run the other
 * order and the event stamped over the Reminders id instead. Either way the
 * next sync found no evidence and created a SECOND event or item.
 *
 * Every alert belongs to the one event, so the calendar claims every entry the
 * Reminders item does not own. There is only one Reminders item, so it claims a
 * single entry. When the other target owns them all, this one gets a copy of
 * the first entry to write into, at the same time, rather than inventing one.
 * A todo with no timing at all has nothing to anchor to, so nothing is recorded.
 */
function recordCalendarSync(reminders: TodoReminder[], eventId: string): TodoReminder[] {
    if (reminders.length === 0) {
        return reminders;
    }

    if (reminders.every((r) => ownedBy(r, "reminders"))) {
        return [...reminders, { ...reminders[0], label: "event start", synced: "calendar" as const, syncId: eventId }];
    }

    return reminders.map((r) => (ownedBy(r, "reminders") ? r : { ...r, synced: "calendar" as const, syncId: eventId }));
}

function recordReminderSync(reminders: TodoReminder[], reminderId: string): TodoReminder[] {
    const index = reminderSlotIndex(reminders);

    if (index !== -1) {
        return reminders.map((r, i) => (i === index ? { ...r, synced: "reminders" as const, syncId: reminderId } : r));
    }

    // Nothing is free to claim: either the calendar owns every entry, or the todo
    // has no timing at all and there is no entry to begin with. The item EXISTS
    // by now either way, so the id still needs a home. Returning the list
    // untouched left no evidence on the todo, and the next sync — which the CLI
    // allows for an untimed todo — created a SECOND item, without limit.
    const anchor = reminders[0] ?? { at: "" };

    return [...reminders, { ...anchor, label: "reminders item", synced: "reminders" as const, syncId: reminderId }];
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

async function syncTodoToCalendar(todo: Todo, calendarName?: string): Promise<string> {
    const reminderTimes = todo.reminders.map(reminderTimeMs).filter((ms): ms is number => ms !== null);

    if (!todo.at && reminderTimes.length === 0) {
        throw new Error("Cannot sync to calendar: no event time (--at) or reminders specified");
    }

    const eventStartMs = todo.at ? new Date(todo.at).getTime() : Math.max(...reminderTimes);

    const eventStart = new Date(eventStartMs);
    const alerts = computeAlertOffsets(eventStartMs, todo.reminders);
    const url = extractUrl(todo.links);

    const eventId = await MacCalendar.createEvent({
        title: todo.title,
        notes: todo.description ?? `Todo: ${todo.id}`,
        startDate: eventStart,
        alerts,
        url,
        calendarName,
    });

    return assertIdentifier(eventId, "calendar");
}

async function syncTodoToReminders(todo: Todo): Promise<string> {
    const slot = reminderSlotIndex(todo.reminders);
    // -1 means the calendar owns every entry, and `recordReminderSync` then
    // appends a copy of entry 0 — so entry 0 is the time this item really gets.
    const entry = todo.reminders[slot === -1 ? 0 : slot];
    const dueMs = entry ? reminderTimeMs(entry) : null;
    const dueDate = dueMs === null ? undefined : new Date(dueMs);
    const url = extractUrl(todo.links);

    const reminderId = await MacReminders.createReminder({
        title: todo.title,
        notes: todo.description ?? `Todo: ${todo.id}`,
        dueDate,
        priority: todoPriorityToApple(todo.priority),
        url,
    });

    return assertIdentifier(reminderId, "reminders");
}

/**
 * Sync a todo's reminders to Calendar and/or Reminders.app.
 * Returns a SyncResult with per-target outcomes — failures (e.g. DarwinkitTimeoutError,
 * DarwinkitCrashError) are captured per-target instead of throwing, so the caller can
 * decide how to surface them and which targets still succeeded.
 */
export async function syncTodo(options: {
    store: SyncStore;
    todo: Todo;
    target: SyncTarget;
    calendarName?: string;
}): Promise<SyncResult> {
    const { store, todo, target, calendarName } = options;
    const result: SyncResult = {};
    let updatedReminders = materializeReminders(todo);
    let changed = false;

    if (target === "calendar" || target === "both") {
        const previousId = updatedReminders.find((r) => ownedBy(r, "calendar"))?.syncId;

        if (previousId) {
            result.calendar = { ok: true, alreadySynced: true, id: previousId };
        } else {
            try {
                const eventId = await syncTodoToCalendar({ ...todo, reminders: updatedReminders }, calendarName);

                updatedReminders = recordCalendarSync(updatedReminders, eventId);
                changed = true;
                result.calendar = { ok: true, id: eventId };
            } catch (error) {
                result.calendar = { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
            }
        }
    }

    if (target === "reminders" || target === "both") {
        const previousId = updatedReminders.find((r) => ownedBy(r, "reminders"))?.syncId;

        if (previousId) {
            result.reminders = { ok: true, alreadySynced: true, id: previousId };
        } else {
            try {
                const reminderId = await syncTodoToReminders({ ...todo, reminders: updatedReminders });

                updatedReminders = recordReminderSync(updatedReminders, reminderId);
                changed = true;
                result.reminders = { ok: true, id: reminderId };
            } catch (error) {
                result.reminders = {
                    ok: false,
                    error: error instanceof Error ? error : new Error(String(error)),
                };
            }
        }
    }

    if (changed) {
        // The platform call above can take seconds, and `updatedReminders` was
        // derived from `todo` as it looked BEFORE it. Writing that array whole
        // would drop a reminder another writer appended meanwhile. Entries past
        // the snapshot's length are carried over untouched: they are new alerts
        // this event was never built with, so they keep an empty `synced` rather
        // than being stamped with an id that does not cover them.
        const carried = todo.reminders.length;

        try {
            await store.updateWith(todo.id, (current) => ({
                reminders: [...updatedReminders, ...current.reminders.slice(carried)],
            }));
        } catch (error) {
            // This function promises to capture failures per target instead of
            // throwing, and `sync --all` loops over it, so one unwritable todo
            // must not abort the batch. The platform objects already EXIST by
            // now, so their ids go into the failure message: an id nobody can
            // read is an orphaned event with nothing on record pointing at it.
            // `alreadySynced` outcomes are left alone — they created nothing,
            // so there is nothing of theirs to lose.
            const cause = error instanceof Error ? error : new Error(String(error));

            for (const key of SYNC_TARGETS) {
                const outcome = result[key];

                if (outcome?.ok && !outcome.alreadySynced) {
                    result[key] = {
                        ok: false,
                        error: new Error(`created ${outcome.id} but could not record it: ${cause.message}`),
                    };
                }
            }
        }
    }

    return result;
}
