import type { TodoReminder } from "./types";

const RELATIVE_RE = /^(\d+)(m|h|d|w)$/i;

const MULTIPLIERS: Record<string, number> = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
};

export function parseReminderTime(input: string, now?: Date): string {
    if (!input) {
        throw new Error("Reminder time cannot be empty");
    }

    const match = input.match(RELATIVE_RE);

    if (match) {
        const amount = parseInt(match[1], 10);
        const unit = match[2].toLowerCase();
        const base = now ?? new Date();
        return new Date(base.getTime() + amount * MULTIPLIERS[unit]).toISOString();
    }

    const dateWithTime = input.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

    if (dateWithTime) {
        const parsed = new Date(input.replace(" ", "T"));

        if (Number.isNaN(parsed.getTime())) {
            throw new Error(`Invalid date format: ${input}`);
        }

        return parsed.toISOString();
    }

    const parsed = new Date(input);

    if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Invalid reminder time: ${input}`);
    }

    return parsed.toISOString();
}

/** The label of the alert a todo gets at its own start when the user gave none. */
export const EVENT_START_LABEL = "event start";

/**
 * The alerts a todo carries once it has a start time.
 *
 * "With --at and no --reminder, one alert is placed at the event start" is a promise about the
 * RECORD, so `add` and `edit --at` write it, and `sync` uses the same rule for a record made
 * before they did. A start time that moves takes the automatic alert along while no platform
 * owns it (`synced` is null); an alert a user gave, or one an event already carries, stays.
 */
export function alertsForStart({
    reminders,
    previousAt,
    at,
}: {
    reminders: TodoReminder[];
    previousAt?: string;
    at?: string;
}): TodoReminder[] {
    if (at === undefined) {
        return reminders;
    }

    if (reminders.length === 0) {
        return [{ at, label: EVENT_START_LABEL, synced: null }];
    }

    return reminders.map((reminder) =>
        previousAt !== undefined &&
        reminder.label === EVENT_START_LABEL &&
        reminder.synced === null &&
        reminder.at === previousAt
            ? { ...reminder, at }
            : reminder
    );
}

export function parseReminders(inputs: string[]): TodoReminder[] {
    return inputs.map((input) => ({
        at: parseReminderTime(input),
        synced: null,
    }));
}
