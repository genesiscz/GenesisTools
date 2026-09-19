import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { hasToolBlocks, type MessageRow, pairRows } from "./pairing";
import { type CompactFormat, type CompactMessage, genericMessageSchema } from "./schema";

const log = logger.child({ component: "ai:compact:format" });

const DETECTION_SAMPLE_LINES = 50;

function parseLine(line: string): Record<string, unknown> | undefined {
    try {
        const value = SafeJSON.parse(line, { jsonl: true });
        return value !== null && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined;
    } catch (error) {
        log.debug({ error, chars: line.length }, "compact input line is not JSON; kept verbatim");
        return undefined;
    }
}

/** A Claude/Codex/Grok transcript row: `{ type, message: { role, content } }`, no top-level role. */
function looksNative(row: Record<string, unknown>): boolean {
    return typeof row.role !== "string" && typeof row.type === "string" && typeof row.message === "object";
}

/**
 * Picks the input shape from the text alone. `--source` overrides this; nothing here reads the
 * file name, so stdin and a file are detected the same way.
 */
export function detectCompactFormat(text: string): CompactFormat {
    const trimmed = text.trim();
    if (!trimmed) {
        return "generic-jsonl";
    }

    if (trimmed.startsWith("[")) {
        return "json-array";
    }

    let blocks = false;
    let seen = 0;
    for (const line of trimmed.split(/\r?\n/)) {
        if (!line.trim() || seen >= DETECTION_SAMPLE_LINES) {
            continue;
        }

        seen += 1;
        const row = parseLine(line);
        if (!row) {
            continue;
        }

        if (looksNative(row)) {
            return "native";
        }

        if (hasToolBlocks(row.content)) {
            blocks = true;
        }
    }

    return blocks ? "blocks-jsonl" : "generic-jsonl";
}

function toRow(value: unknown): MessageRow | undefined {
    const parsed = genericMessageSchema.safeParse(value);
    if (!parsed.success) {
        return undefined;
    }

    const row = parsed.data;
    return {
        role: row.role,
        content: row.content,
        toolCalls: row.toolCalls,
        toolCallId: row.tool_call_id ?? row.tool_use_id,
        name: row.name,
    };
}

function verbatim(index: number, raw: string): CompactMessage {
    return { index, role: "other", content: "", toolCalls: [], raw };
}

/**
 * Turns generic JSONL, Anthropic-block JSONL or a JSON array into one model.
 *
 * A line that is not JSON, or that carries no `role`, is kept VERBATIM and never decided on: an
 * input this parser does not understand must survive compaction untouched rather than vanish.
 */
export function parseCompactDocument(text: string, format: CompactFormat): CompactMessage[] {
    if (format === "json-array") {
        const parsed = SafeJSON.parse(text, { jsonl: true });
        if (!Array.isArray(parsed)) {
            throw new Error("compact --source json expects a JSON array of messages.");
        }

        const rows = parsed.map((item) => toRow(item));
        const paired = pairRows(rows.map((row) => row ?? { role: "other" }));
        return paired.map((message, index) =>
            rows[index] ? message : verbatim(index, SafeJSON.stringify(parsed[index], { jsonl: true }))
        );
    }

    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
    const rows = lines.map((line) => {
        const row = parseLine(line);
        return row ? toRow(row) : undefined;
    });
    const paired = pairRows(rows.map((row) => row ?? { role: "other" }));
    return paired.map((message, index) => (rows[index] ? message : verbatim(index, lines[index] ?? "")));
}

/** Head-truncation with the byte count the reader needs to know what was cut. */
export function truncateResult(result: string, maxChars: number): string {
    if (result.length <= maxChars) {
        return result;
    }

    return `${result.slice(0, maxChars)}\n… [${result.length} chars, truncated]`;
}

/**
 * Every output message is emitted in the generic shape, whatever the input shape was, so a
 * compacted transcript always parses back as `generic-jsonl`.
 */
export function serializeCompactMessage(message: CompactMessage): string {
    if (message.raw !== undefined) {
        return message.raw;
    }

    const payload: Record<string, unknown> = { role: message.role, content: message.content };
    if (message.toolCalls.length) {
        payload.toolCalls = message.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            ...(call.input === undefined ? {} : { input: call.input }),
            ...(call.result === undefined ? {} : { result: call.result }),
        }));
    }

    return SafeJSON.stringify(payload, { jsonl: true });
}

export function measureBytes(lines: string[]): number {
    return lines.reduce((total, line) => total + Buffer.byteLength(line, "utf8") + 1, 0);
}
