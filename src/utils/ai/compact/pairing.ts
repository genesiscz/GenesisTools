import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type CompactMessage, type CompactToolCall, roleKind } from "./schema";

const log = logger.child({ component: "ai:compact:pairing" });

/** One parsed source row, before the four input shapes are folded into one model. */
export interface MessageRow {
    role: string;
    content?: unknown;
    /** Generic shape: tool calls attached to the message, each carrying its own result. */
    toolCalls?: unknown;
    /** Generic shape: this message IS the result of an earlier call. */
    toolCallId?: string;
    /** Generic shape: tool name on a bare `role: "tool"` row. */
    name?: string;
}

interface ToolUseBlock {
    id: string;
    name: string;
    input?: string;
}

interface ToolResultBlock {
    id: string;
    result: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/** Flattens a block payload (string, text-block array, or object) into one verbatim string. */
export function flattenText(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }

    if (Array.isArray(value)) {
        return value
            .map((item) => flattenText(item))
            .filter((item) => item !== "")
            .join("\n");
    }

    const block = record(value);
    if (!block) {
        return value === undefined || value === null ? "" : String(value);
    }

    if (typeof block.text === "string") {
        return block.text;
    }

    if (typeof block.thinking === "string") {
        return block.thinking;
    }

    if (typeof block.content === "string" || Array.isArray(block.content)) {
        return flattenText(block.content);
    }

    return SafeJSON.stringify(block, { jsonl: true });
}

/**
 * Splits one message's `content` into verbatim text plus the tool blocks it declares.
 * Anything that is neither a `tool_use` nor a `tool_result` counts as text and is carried through
 * untouched, so a thinking block is never silently deleted by the parser.
 */
export function readBlocks(content: unknown): { text: string; uses: ToolUseBlock[]; results: ToolResultBlock[] } {
    if (!Array.isArray(content)) {
        return { text: flattenText(content), uses: [], results: [] };
    }

    const textParts: string[] = [];
    const uses: ToolUseBlock[] = [];
    const results: ToolResultBlock[] = [];
    for (const item of content) {
        const block = record(item);
        if (!block) {
            textParts.push(flattenText(item));
            continue;
        }

        if (block.type === "tool_use" && typeof block.id === "string") {
            uses.push({
                id: block.id,
                name: typeof block.name === "string" ? block.name : "tool",
                input: block.input === undefined ? undefined : flattenText(block.input),
            });
            continue;
        }

        if (block.type === "tool_result") {
            const id = typeof block.tool_use_id === "string" ? block.tool_use_id : String(block.id ?? "");
            results.push({ id, result: flattenText(block.content ?? block.result ?? "") });
            continue;
        }

        textParts.push(flattenText(block));
    }

    return { text: textParts.filter((part) => part !== "").join("\n"), uses, results };
}

export function hasToolBlocks(content: unknown): boolean {
    if (!Array.isArray(content)) {
        return false;
    }

    return content.some((item) => {
        const block = record(item);
        return block?.type === "tool_use" || block?.type === "tool_result";
    });
}

function genericCalls(row: MessageRow, index: number): ToolUseBlock[] {
    if (!Array.isArray(row.toolCalls)) {
        return [];
    }

    return row.toolCalls.map((item, position) => {
        const call = record(item) ?? {};
        return {
            id: typeof call.id === "string" && call.id ? call.id : `g${index}_${position}`,
            name: typeof call.name === "string" ? call.name : "tool",
            input: call.input === undefined ? undefined : flattenText(call.input),
        };
    });
}

function inlineResults(row: MessageRow, uses: ToolUseBlock[]): Map<string, string> {
    const inline = new Map<string, string>();
    if (!Array.isArray(row.toolCalls)) {
        return inline;
    }

    for (const [position, item] of row.toolCalls.entries()) {
        const call = record(item) ?? {};
        const id = uses[position]?.id;
        if (id !== undefined && call.result !== undefined) {
            inline.set(id, flattenText(call.result));
        }
    }

    return inline;
}

/**
 * Folds every accepted input shape into one model and links each tool call to its result.
 *
 * A result that arrives in a LATER message becomes `resultFrom` on the call, which is what lets a
 * drop remove BOTH blocks: dropping a call without its result leaves an orphan `tool_result` that
 * every provider rejects. Results that arrive BEFORE their call (a shuffled export) are held and
 * attached when the call shows up.
 */
export function pairRows(rows: MessageRow[]): CompactMessage[] {
    const messages: CompactMessage[] = [];
    const byId = new Map<string, CompactToolCall>();
    const pending = new Map<string, { result: string; from: number }>();

    for (const [index, row] of rows.entries()) {
        const blocks = readBlocks(row.content);
        const generic = genericCalls(row, index);
        const uses = [...blocks.uses, ...generic];
        const inline = inlineResults(row, generic);
        const kind = roleKind(row.role);
        const results = [...blocks.results];
        let text = blocks.text;

        if (kind === "tool" && !uses.length && !results.length) {
            const id = row.toolCallId ?? `t${index}`;
            results.push({ id, result: text });
            text = "";
            if (row.toolCallId === undefined) {
                uses.push({ id, name: row.name ?? "tool" });
            }
        }

        const calls: CompactToolCall[] = uses.map((use) => {
            const call: CompactToolCall = { id: use.id, name: use.name, input: use.input };
            const held = pending.get(use.id);
            if (held) {
                call.result = held.result;
                call.resultFrom = held.from;
                pending.delete(use.id);
            }

            const own = inline.get(use.id);
            if (own !== undefined) {
                call.result = own;
            }

            byId.set(use.id, call);
            return call;
        });

        for (const result of results) {
            const call = byId.get(result.id);
            if (call) {
                call.result = result.result;
                call.resultFrom = index;
                continue;
            }

            pending.set(result.id, { result: result.result, from: index });
        }

        messages.push({ index, role: kind, content: text, toolCalls: calls });
    }

    if (pending.size) {
        log.debug({ orphans: [...pending.keys()] }, "tool results with no matching tool call");
    }

    return messages;
}

/** Call id → the message that declared the call and the message that carried its result. */
export function pairToolCalls(messages: CompactMessage[]): Map<string, { call: number; result?: number }> {
    const pairs = new Map<string, { call: number; result?: number }>();
    for (const message of messages) {
        for (const call of message.toolCalls) {
            pairs.set(call.id, { call: message.index, result: call.resultFrom });
        }
    }

    return pairs;
}
