const DAYS_PATTERN = /^(\d+)d$/;
const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Resolve a --since value to an inclusive UTC day key (YYYY-MM-DD), or undefined if unparseable. */
export function resolveSince(input: string, now: Date): string | undefined {
    const trimmed = input.trim();

    const days = trimmed.match(DAYS_PATTERN);
    if (days) {
        const back = Number.parseInt(days[1], 10);
        const d = new Date(now.getTime() - back * 24 * 60 * 60 * 1000);
        return d.toISOString().slice(0, 10);
    }

    if (ISO_DAY_PATTERN.test(trimmed)) {
        return trimmed;
    }

    return undefined;
}
