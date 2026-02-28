export interface ParsedInterval {
    intervalMs: number;
    atHour?: number;
    atMinute?: number;
    isTimeOfDay: boolean;
}

const INTERVAL_PATTERN = /^every\s+(\d+)\s+(second|minute|hour|day|week)s?$/i;
const DAILY_AT_PATTERN = /^every\s+day\s+at\s+(\d{1,2}):(\d{2})$/i;

const MULTIPLIERS: Record<string, number> = {
    second: 1_000,
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
};

export function parseInterval(interval: string): ParsedInterval {
    const dailyMatch = interval.match(DAILY_AT_PATTERN);

    if (dailyMatch) {
        const hour = parseInt(dailyMatch[1], 10);
        const minute = parseInt(dailyMatch[2], 10);

        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
            throw new Error(`Invalid time: "${interval}" — hour 0-23, minute 0-59`);
        }

        return { intervalMs: 86_400_000, atHour: hour, atMinute: minute, isTimeOfDay: true };
    }

    const match = interval.match(INTERVAL_PATTERN);

    if (!match) {
        throw new Error(`Invalid interval: "${interval}". Expected "every N minutes", "every day at HH:MM", etc.`);
    }

    const value = parseInt(match[1], 10);

    if (value <= 0) {
        throw new Error(`Invalid interval: "${interval}". Value must be greater than 0.`);
    }

    const unit = match[2].toLowerCase();

    return { intervalMs: value * MULTIPLIERS[unit], isTimeOfDay: false };
}

export function computeNextRunAt(parsed: ParsedInterval, from: Date = new Date()): Date {
    if (parsed.isTimeOfDay && parsed.atHour !== undefined && parsed.atMinute !== undefined) {
        const next = new Date(from);
        next.setHours(parsed.atHour, parsed.atMinute, 0, 0);

        if (next <= from) {
            next.setDate(next.getDate() + 1);
        }

        return next;
    }

    return new Date(from.getTime() + parsed.intervalMs);
}

export function formatInterval(every: string): string {
    try {
        const parsed = parseInterval(every);

        if (parsed.isTimeOfDay) {
            return `daily at ${String(parsed.atHour).padStart(2, "0")}:${String(parsed.atMinute).padStart(2, "0")}`;
        }

        const seconds = parsed.intervalMs / 1000;

        if (seconds < 60) {
            return `every ${seconds}s`;
        }

        if (seconds < 3600) {
            return `every ${seconds / 60}m`;
        }

        if (seconds < 86400) {
            return `every ${seconds / 3600}h`;
        }

        return `every ${seconds / 86400}d`;
    } catch {
        return every;
    }
}
