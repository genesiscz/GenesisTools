/**
 * Codex's `session_index.jsonl`: one row per thread rename, `{id, thread_name, updated_at}`. Parsed here once, for both
 * readers of it: history discovery (`codex-discovery.ts`, a thread's title and update time) and the Codex driver's
 * `locate` part (title search).
 */
import { readFileSync } from "node:fs";
import type { TitledSession } from "@genesiscz/utils/ai/transcripts/session-title";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/** One parsed row of a session index. */
export interface CodexIndexRow {
    /** 1-based line in the file. */
    line: number;
    /** The row's own text, a fingerprint of what it says. */
    original: string;
    /** The thread id (`id`, older rows `session_id`). */
    id: string;
    /** The thread's name (`thread_name`, older rows `title`), when the row names one. */
    title?: string;
    /** The raw `updated_at` (ISO text or epoch seconds or ms). */
    updatedAt?: string | number;
}

/**
 * Epoch ms of a Codex time: ISO text, or a number of epoch seconds (below 1e10) or ms. Undefined when it reads as no
 * time. History discovery and title search both read `updated_at` through it, so both order sessions the same way.
 */
export function codexTimeMs(value: unknown): number | undefined {
    const ms =
        typeof value === "number"
            ? value < 10_000_000_000
                ? value * 1000
                : value
            : typeof value === "string"
              ? Date.parse(value)
              : Number.NaN;
    return Number.isNaN(ms) ? undefined : ms;
}

function field(value: unknown, key: string): unknown {
    return typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
}

function textOf(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Every row of a session index's text that names a thread, in file order. A line that does not parse is reported to
 * `onMalformed` with its 1-based number and skipped; a row with no id is skipped silently.
 */
export function codexIndexRows(raw: string, onMalformed: (line: number) => void): CodexIndexRow[] {
    const rows: CodexIndexRow[] = [];

    for (const [index, original] of raw.split("\n").entries()) {
        if (!original.trim()) {
            continue;
        }

        let value: unknown;

        try {
            value = SafeJSON.parse(original, { strict: true });
        } catch {
            onMalformed(index + 1);
            continue;
        }

        const id = textOf(field(value, "id")) ?? textOf(field(value, "session_id"));

        if (!id) {
            continue;
        }

        const title = textOf(field(value, "thread_name")) ?? textOf(field(value, "title"));
        const updated = field(value, "updated_at");
        rows.push({
            line: index + 1,
            original,
            id,
            ...(title ? { title } : {}),
            ...(typeof updated === "string" || typeof updated === "number" ? { updatedAt: updated } : {}),
        });
    }

    return rows;
}

/**
 * Adds the titles of one `session_index.jsonl` to `found`. Codex appends a line per rename, in write order, so the
 * last line of an id is its current title.
 */
export function readCodexTitleIndex(indexPath: string, found: Map<string, TitledSession>): void {
    const rows = codexIndexRows(readFileSync(indexPath, "utf8"), (line) =>
        logger.debug({ indexPath, line }, "[session-title] skipped an unreadable Codex index line")
    );

    for (const row of rows) {
        if (!row.title) {
            continue;
        }

        found.delete(row.id);
        found.set(row.id, {
            sessionId: row.id,
            title: row.title,
            mtime: codexTimeMs(row.updatedAt) ?? 0,
            locator: row.id,
        });
    }
}
