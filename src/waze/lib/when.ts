/**
 * A departure time from the command line: `now`, `HH:MM` (today, or tomorrow once that time has passed), `tomorrow
 * HH:MM`, an ISO date-time, or epoch milliseconds. Returns epoch milliseconds, or undefined when the text is none of
 * these.
 */
export function parseWhen(text: string, now: number): number | undefined {
    const value = text.trim().toLowerCase();
    if (value === "now") {
        return now;
    }

    if (/^\d{12,14}$/.test(value)) {
        return Number(value);
    }

    const clock = value.match(/^(tomorrow\s+)?(\d{1,2})[:.](\d{2})$/);
    if (clock) {
        const hours = Number(clock[2]);
        const minutes = Number(clock[3]);
        if (hours > 23 || minutes > 59) {
            return undefined;
        }

        const date = new Date(now);
        date.setHours(hours, minutes, 0, 0);
        if (clock[1]) {
            date.setDate(date.getDate() + 1);
        } else if (date.getTime() < now - 60_000) {
            date.setDate(date.getDate() + 1);
        }

        return date.getTime();
    }

    if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
        const parsed = Date.parse(text.trim());
        return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
}

/** `90s`, `5m`, `2h`, or a bare number of minutes → milliseconds; undefined for anything else. */
export function parseInterval(text: string): number | undefined {
    const match = text.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|min|h)?$/i);
    if (!match) {
        return undefined;
    }

    const amount = Number(match[1]);
    const unit = (match[2] ?? "m").toLowerCase();
    const factor = unit === "s" ? 1000 : unit === "h" ? 3_600_000 : 60_000;
    return Math.round(amount * factor);
}
