import { z } from "zod";

export const COMPACT_ROLES = ["user", "assistant", "system", "tool", "other"] as const;
export type CompactRole = (typeof COMPACT_ROLES)[number];

/**
 * The four input shapes `compact` accepts. Detection is automatic; `--source` forces it.
 *
 * - `generic-jsonl`: one `{ role, content, toolCalls?: [{ id, name, input?, result? }] }` per line.
 * - `blocks-jsonl`: one Anthropic-style message per line, `content` an array of blocks that may
 *   carry `tool_use` and `tool_result`. A result usually lands in a LATER message than its call.
 * - `json-array`: a single JSON array of messages in either of the two shapes above.
 * - `native`: a Claude, Codex or Grok transcript, read through the agent-sessions readers.
 */
export const COMPACT_FORMATS = ["generic-jsonl", "blocks-jsonl", "json-array", "native"] as const;
export type CompactFormat = (typeof COMPACT_FORMATS)[number];

export const COMPACT_VERDICTS = ["keep", "truncate", "drop"] as const;
export type CompactVerdict = (typeof COMPACT_VERDICTS)[number];

export const genericToolCallSchema = z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    input: z.unknown().optional(),
    result: z.unknown().optional(),
});

export const genericMessageSchema = z
    .object({
        role: z.string(),
        content: z.unknown().optional(),
        name: z.string().optional(),
        tool_call_id: z.string().optional(),
        tool_use_id: z.string().optional(),
        toolCalls: z.array(genericToolCallSchema).optional(),
    })
    .loose();

export interface CompactToolCall {
    /** Unique within the document. Synthesised as `c<n>` when the source carries no id. */
    id: string;
    name: string;
    input?: string;
    result?: string;
    /** Index of the message that carried the result, when it arrived separately from the call. */
    resultFrom?: number;
}

export interface CompactMessage {
    index: number;
    role: CompactRole;
    /** Verbatim text. Layer 1 and layer 2 never rewrite this field. */
    content: string;
    toolCalls: CompactToolCall[];
    /** Set only for a line that could not be parsed: it is emitted verbatim and never decided on. */
    raw?: string;
}

export interface CompactDecision {
    callId: string;
    messageIndex: number;
    toolName: string;
    verdict: CompactVerdict;
    /** Why this verdict was chosen: a layer-1 rule name, `jev`, or `jev_summary`. */
    reason: string;
    layer: 1 | 2;
    resultChars: number;
    keptChars: number;
    /** True when the kept result text is a generated summary rather than source text. */
    summary?: boolean;
    /** The accepted summary. Layer 2 never writes into the input messages; rendering reads this. */
    summaryText?: string;
}

export interface CompactStats {
    inBytes: number;
    outBytes: number;
    reduction: number;
    unchanged: boolean;
}

export interface CompactLayer2Stats {
    used: boolean;
    jevRequests: number;
    summaries: number;
    replaced: number;
    discarded: number;
}

export interface CompactResult {
    format: CompactFormat;
    messages: CompactMessage[];
    /** One serialized JSON line per output message. Parses back as `generic-jsonl`. */
    lines: string[];
    decisions: CompactDecision[];
    stats: CompactStats;
    layer2: CompactLayer2Stats;
    counts: { messages: number; toolCalls: number; sourceBytes: number };
    /** Present when nothing changed, e.g. `below_threshold` or `no_tool_calls`. */
    reason?: string;
}

export const SUMMARY_MARKER = "[summary]";

export function roleKind(role: string): CompactRole {
    if (role === "user" || role === "human") {
        return "user";
    }

    if (role === "assistant" || role === "model") {
        return "assistant";
    }

    if (role === "tool" || role === "tool_result" || role === "function") {
        return "tool";
    }

    if (role === "system") {
        return "system";
    }

    return "other";
}

/** A message that carries no text of its own and no surviving tool call is not worth emitting. */
export function isEmptyMessage(message: CompactMessage): boolean {
    return message.raw === undefined && message.content.trim() === "" && message.toolCalls.length === 0;
}
