import { join } from "node:path";
import { aiDataDir } from "../config/paths";

/**
 * Where usage rows live: `~/.genesis-tools/ai/usage/YYYY-MM-DD.jsonl`, one
 * append-only file per UTC day.
 *
 * Day files rather than one growing log because every read is a time range, and
 * a range read that can skip whole files never has to parse the years it does
 * not want. UTC rather than local because a file whose boundary moves twice a
 * year is a file whose totals move with it.
 *
 * The directory is reached through `aiDataDir()` deliberately. Constructing a
 * second `Storage` for the `ai` tool outside `src/utils/ai/config/` fails
 * `scripts/ci/ai-credentials-guard.sh` rule 3 (the AI config has exactly one
 * writer), and the accessor is the sanctioned way to sit next to that config
 * without becoming a second writer of it. The guard matches the literal call in
 * comments too, so do not spell it out here.
 */
export function usageDir(): string {
    return aiDataDir("usage");
}

/** UTC calendar day of an instant, as `YYYY-MM-DD`. */
export function utcDayOf(at: Date): string {
    return at.toISOString().slice(0, 10);
}

export function dayFilePath(day: string): string {
    return join(usageDir(), `${day}.jsonl`);
}

/**
 * Every UTC day touched by `[from, to)`, oldest first.
 *
 * The end bound is exclusive, but a `to` that lands mid-day still needs that
 * day's file read — the rows before the instant are in range. An empty array
 * means the window is empty or inverted, which is a caller error the reader
 * reports as zero rows rather than throwing.
 */
export function daysInRange(from: Date, to: Date): string[] {
    if (!(from < to)) {
        return [];
    }

    const days: string[] = [];
    const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
    const last = utcDayOf(to);

    while (utcDayOf(cursor) <= last) {
        days.push(utcDayOf(cursor));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return days;
}

/**
 * Accept both `2026-07-29` and a full ISO instant.
 *
 * A bare date means midnight UTC, which is what makes `from: "2026-07-01"`,
 * `to: "2026-08-01"` read as "July" rather than "July minus its last day".
 */
export function parseBound(value: string): Date {
    const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
    const parsed = new Date(normalized);

    if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Not a date: "${value}". Pass an ISO instant or YYYY-MM-DD.`);
    }

    return parsed;
}
