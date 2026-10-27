import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    statSync,
    unlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

/**
 * Codex's own way to compact (codex-rs `compact_remote_v2`): the turn's Responses request with one extra input item,
 * `{"type":"compaction_trigger"}`, at the session's own effort, so the cached prefix stays whole. The server answers
 * with exactly one `{"type":"compaction", "encrypted_content"}` item and writes no readable summary.
 *
 * Claude Code needs text for its summary, so it gets a short note with a marker. The proxy keeps the item (and the
 * history it compacted) on disk, and swaps the marker back for the item on every later request. The item is readable
 * only by the Codex login that made it: on another login the proxy compacts the saved history once more there.
 * Measured 2026-10-27: a 26K-token compaction hit 25.8K of cache, and the next turn recalled the earlier question.
 */

const MARKER = /\[codex-compaction (gtc1\.[0-9a-f-]{36})\]/;

export interface CompactionRecord {
    id: string;
    model: string;
    createdAt: string;
    /** The compaction item per login (`accountHash8`). */
    items: Record<string, Record<string, unknown>>;
    /**
     * The Responses input the item compacts, without the trigger and with earlier markers left as text: the source
     * for another login's item, whose own earlier items are restored for that login first.
     */
    history: unknown[];
}

function isCompactionRecord(value: unknown): value is CompactionRecord {
    return (
        isObject(value) &&
        typeof value.id === "string" &&
        typeof value.model === "string" &&
        typeof value.createdAt === "string" &&
        isObject(value.items) &&
        Object.values(value.items).every(isObject) &&
        Array.isArray(value.history)
    );
}

function compactionDir(): string {
    return join(getAiProxyStorage().getBaseDir(), "compactions");
}

function recordPath(id: string): string {
    return join(compactionDir(), `${id}.json`);
}

export function saveCompaction(record: CompactionRecord): void {
    mkdirSync(compactionDir(), { recursive: true, mode: 0o700 });
    // The history is the conversation itself: readable by this user only, like the proxy's transcripts.
    writeFileSync(recordPath(record.id), SafeJSON.stringify(record), { mode: 0o600 });
}

export function loadCompaction(id: string): CompactionRecord | undefined {
    const path = recordPath(id);

    if (!existsSync(path)) {
        return undefined;
    }

    try {
        const parsed: unknown = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });

        if (!isCompactionRecord(parsed)) {
            return undefined;
        }

        // A record in use stays fresh for the sweep, which goes by the file's age.
        const now = new Date();
        utimesSync(path, now, now);

        return parsed;
    } catch (error) {
        logger.warn({ error, path }, "ai-proxy: a compaction record does not read");
        return undefined;
    }
}

/** The summary text Claude Code keeps: what happened, and the marker the proxy swaps for the item. */
export function compactionNote(id: string): string {
    return [
        "Codex compacted the earlier conversation on its server, the way the Codex CLI does. The summary is encrypted and",
        "ai-proxy restores it into every later request; this note is only its placeholder.",
        `[codex-compaction ${id}]`,
    ].join("\n");
}

export function newCompactionId(): string {
    return `gtc1.${crypto.randomUUID()}`;
}

function textParts(item: Record<string, unknown>): Array<Record<string, unknown>> {
    return Array.isArray(item.content)
        ? item.content.filter((part): part is Record<string, unknown> => isObject(part))
        : [];
}

/** The marker ids in a Responses input, with the index of the message that carries each. */
export function compactionMarkers(input: unknown[]): Array<{ index: number; id: string }> {
    const found: Array<{ index: number; id: string }> = [];

    input.forEach((item, index) => {
        if (!isObject(item) || item.type === "compaction") {
            return;
        }

        for (const part of textParts(item)) {
            const match = typeof part.text === "string" ? part.text.match(MARKER) : null;

            if (match?.[1]) {
                found.push({ index, id: match[1] });
                return;
            }
        }
    });

    return found;
}

/**
 * The input with each marker message preceded by its compaction item, and the note cut out of the message's text.
 * `itemFor` returns the item for this login (compacting the saved history again when the login has none), or
 * undefined, which leaves the note in place: the turn then runs on the visible text alone.
 */
export async function expandCompactionMarkers(
    input: unknown[],
    itemFor: (id: string) => Promise<Record<string, unknown> | undefined>
): Promise<unknown[]> {
    const markers = compactionMarkers(input);

    if (markers.length === 0) {
        return input;
    }

    const out = [...input];

    for (const { index, id } of [...markers].reverse()) {
        const item = await itemFor(id);

        if (!item) {
            continue;
        }

        const message = out[index];

        if (isObject(message)) {
            out[index] = {
                ...message,
                content: textParts(message).map((part) =>
                    typeof part.text === "string" && MARKER.test(part.text)
                        ? { ...part, text: part.text.replace(compactionNote(id), "").replace(MARKER, "").trim() }
                        : part
                ),
            };
        }

        out.splice(index, 0, item);
    }

    return out;
}

/** The compaction item in a WHAM Responses stream, and the usage of that request. */
export function compactionFromSse(sse: string): {
    item?: Record<string, unknown>;
    usage?: Record<string, unknown>;
} {
    let item: Record<string, unknown> | undefined;
    let usage: Record<string, unknown> | undefined;

    for (const line of sse.split("\n")) {
        if (!line.startsWith("data: ")) {
            continue;
        }

        try {
            const event: unknown = SafeJSON.parse(line.slice("data: ".length), { strict: true });

            if (!isObject(event)) {
                continue;
            }

            if (
                event.type === "response.output_item.done" &&
                isObject(event.item) &&
                event.item.type === "compaction"
            ) {
                item = event.item;
            }

            if (event.type === "response.completed" && isObject(event.response) && isObject(event.response.usage)) {
                usage = event.response.usage;
            }
        } catch (error) {
            logger.debug({ error }, "ai-proxy: a compaction stream frame is not JSON");
        }
    }

    return { item, usage };
}

/** Deletes compaction records no request has used for `retentionDays` (the proxy's session retention). */
export function sweepCompactions(retentionDays: number, now = Date.now()): string[] {
    const dir = compactionDir();

    if (!existsSync(dir)) {
        return [];
    }

    const pruned: string[] = [];

    for (const name of readdirSync(dir)) {
        const path = join(dir, name);

        if (name.endsWith(".json") && now - statSync(path).mtimeMs > retentionDays * 86_400_000) {
            unlinkSync(path);
            pruned.push(name);
        }
    }

    return pruned;
}
