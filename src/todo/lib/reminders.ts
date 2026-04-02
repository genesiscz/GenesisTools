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

export function parseReminders(inputs: string[]): TodoReminder[] {
    return inputs.map((input) => ({
        at: parseReminderTime(input),
        synced: null,
    }));
}
