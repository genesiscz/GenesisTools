import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    statSync,
    unlinkSync,
    utimesSync,
} from "node:fs";
import { join } from "node:path";
import { isCompactionId } from "@app/ai-proxy/lib/sessions/records";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import { withPathArbitrationSync } from "@genesiscz/utils/process/path-arbitration";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";

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
    if (!isCompactionId(id)) {
        throw new Error("Invalid compaction ID");
    }

    return join(compactionDir(), `${id}.json`);
}

export function saveCompaction(record: CompactionRecord): void {
    mkdirSync(compactionDir(), { recursive: true, mode: 0o700 });
    // The history is the conversation itself: readable by this user only, like the proxy's transcripts.
    const path = recordPath(record.id);
    withPathArbitrationSync(path, () => atomicWriteFileSync(path, SafeJSON.stringify(record), { mode: 0o600 }));
}

export function restoreCompaction(id: string, from: string): { backup?: string } {
    const path = recordPath(id);
    const raw = readFileSync(from, "utf8");
    const value: unknown = SafeJSON.parse(raw, { strict: true });

    if (!isCompactionRecord(value) || value.id !== id) {
        throw new Error("The supplied file is not the requested compaction record");
    }

    mkdirSync(compactionDir(), { recursive: true, mode: 0o700 });
    return withPathArbitrationSync(path, () => {
        let backup: string | undefined;

        if (existsSync(path)) {
            backup = `${path}.${crypto.randomUUID()}.bak`;
            copyFileSync(path, backup);
        }

        atomicWriteFileSync(path, raw, { mode: 0o600 });
        return { backup };
    });
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
export function compactionNote(id: string, fallback?: string): string {
    const marker = [
        "Codex compacted the earlier conversation on its server, the way the Codex CLI does. The summary is encrypted and",
        "ai-proxy restores it into every later request; this note is only its placeholder.",
        `[codex-compaction ${id}]`,
    ].join("\n");

    return fallback?.trim()
        ? `[codex-compaction-fallback ${id}]\n${fallback.trim()}\n[/codex-compaction-fallback ${id}]\n` +
              fallbackNote(id)
        : marker;
}

function fallbackNote(id: string): string {
    return `The proxy can restore the encrypted Codex item; otherwise use the readable summary above.\n[codex-compaction ${id}]`;
}

function compactionNoteIds(text: string): string[] {
    return [...text.matchAll(new RegExp(MARKER, "g"))]
        .map((match) => match[1])
        .filter(
            (id): id is string =>
                typeof id === "string" &&
                isCompactionId(id) &&
                (text.includes(compactionNote(id)) || text.includes(fallbackNote(id)))
        );
}

/** A readable fallback must be present in the same text as its marker. */
export function hasCompactionFallback(text: string, id: string): boolean {
    const start = `[codex-compaction-fallback ${id}]`;
    const end = `[/codex-compaction-fallback ${id}]`;
    const first = text.indexOf(start);
    const last = text.indexOf(end, first + start.length);

    return first >= 0 && last > first + start.length && text.slice(first + start.length, last).trim().length > 0;
}

/** Inspect user text, not tool results or assistant text, for actual compaction notes without a fallback. */
export function findUnrecoverableCompaction(messages: unknown): string | undefined {
    if (!Array.isArray(messages)) {
        return undefined;
    }

    for (const message of messages) {
        if (!isObject(message) || message.role !== "user") {
            continue;
        }

        const content = message.content;
        const texts =
            typeof content === "string"
                ? [content]
                : Array.isArray(content)
                  ? content.flatMap((part) =>
                        isObject(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []
                    )
                  : [];

        for (const text of texts) {
            const id = compactionNoteIds(text).find((marker) => !hasCompactionFallback(text, marker));

            if (id) {
                return id;
            }
        }
    }

    return undefined;
}

/** Replace only the exact session-approved note; never touch quoted tool results. */
export function compactionRecoveryMessage(sessionId: string | undefined, marker: string, missingId = marker): string {
    const lost = `Compaction ${marker} has no readable context, so the proxy stops here rather than continue without it.`;

    if (!sessionId) {
        return `${lost} Put the record ${missingId}.json back into ai-proxy/compactions/, or start a new session with a readable handoff.`;
    }

    const restore = toolCommand(
        "ai-proxy session",
        sessionId,
        "compaction-restore",
        "--marker",
        missingId,
        "--from",
        "<record-file>"
    );
    const drop = toolCommand(
        "ai-proxy session",
        sessionId,
        "compaction-drop",
        "--marker",
        marker,
        "--acknowledge-context-loss"
    );
    return (
        `${lost} To restore the saved record: ${restore}. ` +
        `To continue without it: ${drop}, ` +
        "then send the missing context in your next message. " +
        'To avoid this when you switch providers, set claudeSessions.compaction.mode to "summary" first.'
    );
}

export function applyCompactionDrops(messages: unknown, approved: readonly string[]): unknown {
    if (!Array.isArray(messages) || approved.length === 0) {
        return messages;
    }

    const replaceText = (text: string): string => {
        let result = text;

        for (const id of compactionNoteIds(text)) {
            if (approved.includes(id)) {
                result =
                    `${stripCompactionNote(result, id)}\n[Earlier compacted context was explicitly dropped by the user: ${id}.]`.trim();
            }
        }

        return result;
    };

    return messages.map((message) => {
        if (!isObject(message) || message.role !== "user") {
            return message;
        }

        if (typeof message.content === "string") {
            return { ...message, content: replaceText(message.content) };
        }

        if (!Array.isArray(message.content)) {
            return message;
        }

        return {
            ...message,
            content: message.content.map((part) =>
                isObject(part) && part.type === "text" && typeof part.text === "string"
                    ? { ...part, text: replaceText(part.text) }
                    : part
            ),
        };
    });
}

function stripCompactionNote(text: string, id: string): string {
    if (hasCompactionFallback(text, id)) {
        const start = text.indexOf(`[codex-compaction-fallback ${id}]`);
        const close = `[/codex-compaction-fallback ${id}]`;
        const end = text.indexOf(close, start) + close.length;
        text = text.slice(0, start) + text.slice(end);
    }

    return text
        .replace(compactionNote(id), "")
        .replace(fallbackNote(id), "")
        .replace(`[codex-compaction ${id}]`, "")
        .trim();
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
        if (!isObject(item) || item.role !== "user") {
            return;
        }

        for (const part of textParts(item)) {
            const id =
                part.type === "input_text" && typeof part.text === "string"
                    ? compactionNoteIds(part.text)[0]
                    : undefined;

            if (id) {
                found.push({ index, id });
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
                        ? { ...part, text: stripCompactionNote(part.text, id) }
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
    summary?: string;
} {
    let item: Record<string, unknown> | undefined;
    let usage: Record<string, unknown> | undefined;
    let summary = "";
    let completedText = "";
    let messageText = "";

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

            if (event.type === "response.output_item.done" && isObject(event.item) && event.item.type === "message") {
                messageText += textParts(event.item)
                    .filter((part) => part.type === "output_text" && typeof part.text === "string")
                    .map((part) => String(part.text))
                    .join("");
            }

            if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
                summary += event.delta;
            }

            if (event.type === "response.output_text.done" && typeof event.text === "string") {
                completedText += event.text;
            }

            if (event.type === "response.completed" && isObject(event.response)) {
                if (isObject(event.response.usage)) {
                    usage = event.response.usage;
                }

                if (!messageText && Array.isArray(event.response.output)) {
                    messageText = event.response.output
                        .filter(
                            (entry): entry is Record<string, unknown> => isObject(entry) && entry.type === "message"
                        )
                        .flatMap(textParts)
                        .filter((part) => part.type === "output_text" && typeof part.text === "string")
                        .map((part) => String(part.text))
                        .join("");
                }
            }
        } catch (error) {
            logger.debug({ error }, "ai-proxy: a compaction stream frame is not JSON");
        }
    }

    const readable = (summary || completedText || messageText).trim();
    return { item, usage, ...(readable ? { summary: readable } : {}) };
}

/** Deletes compaction records no request has used for `retentionDays` (the proxy's session retention). */
export function sweepCompactions(retentionDays: number, now = Date.now()): string[] {
    const dir = compactionDir();

    if (!existsSync(dir)) {
        return [];
    }

    const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
    const fileNames = new Set(files);
    const cutoff = now - retentionDays * 86_400_000;
    const retained = new Set(files.filter((name) => statSync(join(dir, name)).mtimeMs >= cutoff));
    const pending = [...retained];

    while (pending.length > 0) {
        const name = pending.pop();

        if (!name) {
            continue;
        }

        try {
            const record: unknown = SafeJSON.parse(readFileSync(join(dir, name), "utf8"), { strict: true });

            if (!isCompactionRecord(record)) {
                logger.warn({ name }, "ai-proxy: cannot sweep with an unreadable retained compaction");
                return [];
            }

            for (const { id } of compactionMarkers(record.history)) {
                const dependency = `${id}.json`;

                if (!retained.has(dependency) && fileNames.has(dependency)) {
                    retained.add(dependency);
                    pending.push(dependency);
                }
            }
        } catch (error) {
            logger.warn({ error, name }, "ai-proxy: cannot sweep with an unreadable retained compaction");
            return [];
        }
    }

    const pruned: string[] = [];

    for (const name of files) {
        if (!retained.has(name)) {
            unlinkSync(join(dir, name));
            pruned.push(name);
        }
    }

    return pruned;
}
