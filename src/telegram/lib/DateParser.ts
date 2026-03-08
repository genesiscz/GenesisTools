import * as chrono from "chrono-node";

export function parseDate(input: string): Date | null {
    if (!input) {
        return null;
    }

    const trimmed = input.trim();

    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        const isoDate = new Date(trimmed);

        if (!Number.isNaN(isoDate.getTime())) {
            return isoDate;
        }
    }

    const results = chrono.parse(trimmed);

    if (results.length > 0) {
        return results[0].start.date();
    }

    return null;
}

export function parseDateRange(input: { since?: string; until?: string }): {
    since?: Date;
    until?: Date;
} {
    return {
        since: input.since ? (parseDate(input.since) ?? undefined) : undefined,
        until: input.until ? (parseDate(input.until) ?? undefined) : undefined,
    };
}
