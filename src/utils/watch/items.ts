import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * The item line schema (mobile plan M12): what a polled watch source prints so `tools monitor` can run it as a
 * command watcher with `--items` and give it dedupe, retry, mute, incidents and delivery. One JSON object per stdout
 * line. `guid` is the stable identity Monitor dedupes on: the same change prints the same guid every run, a new
 * change a new one (put the new state in it, for example `<domain>:expires:<date>` or `<product>:price:<amount>`).
 */
export interface WatchItemLine {
    guid: string;
    title: string;
    link?: string | null;
    summary?: string | null;
    /** ISO-8601, when the source knows when the change happened. */
    publishedAt?: string | null;
}

/** The normalized item Monitor stores (every field present). */
export interface WatchItem {
    guid: string;
    title: string;
    link: string | null;
    summary: string | null;
    publishedAt: string | null;
}

/** A command prints at most this many items per run; more would flood the targets on a bad run. */
export const MAX_ITEM_LINES = 200;

function text(value: unknown): string | null {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** One line per item, for a producer's `--items` output. */
export function formatItemLines(items: readonly WatchItemLine[]): string {
    return items.map((item) => SafeJSON.stringify(item)).join("\n");
}

/**
 * The items in a command's stdout. A line that is not a JSON object with a `guid` and a `title` is skipped and
 * counted, so a stray log line does not turn a run into a failure.
 */
export function parseItemLines(stdout: string): { items: WatchItem[]; skipped: number } {
    const items: WatchItem[] = [];
    let skipped = 0;

    for (const raw of stdout.split("\n")) {
        const line = raw.trim();

        if (!line) {
            continue;
        }

        let parsed: unknown;

        try {
            parsed = SafeJSON.parse(line, { strict: true });
        } catch (error) {
            logger.debug({ error, line: line.slice(0, 120) }, "watch items: a line is not JSON");
            skipped++;
            continue;
        }

        const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
        const guid = text(record.guid);
        const title = text(record.title);

        if (!guid || !title) {
            skipped++;
            continue;
        }

        if (items.length < MAX_ITEM_LINES) {
            items.push({
                guid,
                title,
                link: text(record.link),
                summary: text(record.summary),
                publishedAt: text(record.publishedAt),
            });
        } else {
            skipped++;
        }
    }

    return { items, skipped };
}
