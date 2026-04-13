/**
 * Cursor Agent stream-json NDJSON adapter.
 *
 * Parses the NDJSON output from `cursor agent --output-format stream-json`
 * into FormattedBlocks for the TerminalRenderer.
 */

import { SafeJSON } from "@app/utils/json";
import type { FormattedBlock } from "../formatters/types";

// ─── Cursor stream-json event types ────────────────────────────────────────

interface CursorSystemEvent {
    type: "system";
    subtype: "init";
    model: string;
    cwd: string;
    session_id: string;
}

interface CursorUserEvent {
    type: "user";
    message: { role: "user"; content: Array<{ type: "text"; text: string }> };
    session_id: string;
}

interface CursorAssistantEvent {
    type: "assistant";
    message: { role: "assistant"; content: Array<{ type: "text"; text: string }> };
    session_id: string;
    timestamp_ms?: number;
}

interface CursorToolCallEvent {
    type: "tool_call";
    subtype: "started" | "completed";
    call_id: string;
    tool_call: Record<string, { args?: Record<string, unknown>; result?: unknown }>;
    session_id: string;
    timestamp_ms?: number;
}

interface CursorResultEvent {
    type: "result";
    subtype: "success" | "error";
    duration_ms: number;
    is_error: boolean;
    result: string;
    session_id: string;
    usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
    };
}

type CursorEvent = CursorSystemEvent | CursorUserEvent | CursorAssistantEvent | CursorToolCallEvent | CursorResultEvent;

// ─── Tool name extraction ──────────────────────────────────────────────────

const CURSOR_TOOL_SUFFIX = "ToolCall";

/**
 * Extract tool name from Cursor's nested tool_call object.
 * Cursor wraps tool calls as: `{ globToolCall: { args: ... } }`
 * Returns "Glob" from "globToolCall", "Grep" from "grepToolCall", etc.
 */
function extractToolInfo(toolCall: Record<string, unknown>): { name: string; data: Record<string, unknown> } {
    const key = Object.keys(toolCall)[0];

    if (!key) {
        return { name: "unknown", data: {} };
    }

    const data = (toolCall[key] ?? {}) as Record<string, unknown>;

    // "globToolCall" → "glob" → "Glob"
    const rawName = key.endsWith(CURSOR_TOOL_SUFFIX) ? key.slice(0, -CURSOR_TOOL_SUFFIX.length) : key;

    const name = rawName.charAt(0).toUpperCase() + rawName.slice(1);
    return { name, data };
}

// ─── Parsed line result ────────────────────────────────────────────────────

export interface CursorParsedLine {
    blocks: FormattedBlock[];
    textDelta?: string;
    done?: boolean;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Stateful adapter for Cursor's stream-json NDJSON output.
 *
 * Cursor sends many small `assistant` events as streaming deltas,
 * each containing the full accumulated text (not just the new part).
 * This adapter tracks state to compute true deltas.
 */
export class CursorStreamAdapter {
    private lastAssistantText = "";
    private seenFinalAssistant = false;

    /**
     * Parse a single NDJSON line into FormattedBlocks + optional text delta.
     */
    parseLine(line: string): CursorParsedLine {
        const trimmed = line.trim();

        if (!trimmed) {
            return { blocks: [] };
        }

        let event: CursorEvent;

        try {
            event = SafeJSON.parse(trimmed);
        } catch {
            return { blocks: [] };
        }

        switch (event.type) {
            case "system":
                return {
                    blocks: [
                        {
                            type: "metadata",
                            content: `${event.model} · ${event.cwd}`,
                        },
                    ],
                };

            case "user":
                return { blocks: [] };

            case "assistant":
                return this.handleAssistant(event);

            case "tool_call":
                return this.handleToolCall(event);

            case "result":
                return {
                    blocks: [
                        {
                            type: "metadata",
                            content: `${event.subtype} · ${(event.duration_ms / 1000).toFixed(1)}s · ${event.usage?.outputTokens ?? 0} output tokens`,
                        },
                    ],
                    done: true,
                };

            default:
                return { blocks: [] };
        }
    }

    /** Reset state for a new conversation turn. */
    reset(): void {
        this.lastAssistantText = "";
        this.seenFinalAssistant = false;
    }

    // ─── Private handlers ──────────────────────────────────────────────────

    private handleAssistant(event: CursorAssistantEvent): CursorParsedLine {
        const text = event.message.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("");

        // Final accumulated message (no timestamp_ms) — skip, we already streamed it
        if (!event.timestamp_ms) {
            this.seenFinalAssistant = true;
            return { blocks: [] };
        }

        if (this.seenFinalAssistant) {
            return { blocks: [] };
        }

        // Compute delta from last accumulated text
        const delta = text.startsWith(this.lastAssistantText) ? text.slice(this.lastAssistantText.length) : text;

        this.lastAssistantText = text;

        if (!delta) {
            return { blocks: [] };
        }

        return { blocks: [], textDelta: delta };
    }

    private handleToolCall(event: CursorToolCallEvent): CursorParsedLine {
        const { name, data } = extractToolInfo(event.tool_call);

        if (event.subtype === "started") {
            const args = (data.args ?? {}) as Record<string, unknown>;
            const argStr = Object.entries(args)
                .map(([k, v]) => `${k}: ${typeof v === "string" ? v : SafeJSON.stringify(v)}`)
                .join(", ");

            return {
                blocks: [
                    {
                        type: "tool-signature",
                        content: `${name}(${argStr})`,
                        meta: { toolName: name },
                    },
                ],
            };
        }

        if (event.subtype === "completed") {
            const result = data.result as Record<string, unknown> | undefined;
            const isError = !!result?.error;
            const content = isError
                ? SafeJSON.stringify((result?.error as Record<string, unknown>)?.error ?? result?.error)
                : SafeJSON.stringify(result).slice(0, 500);

            return {
                blocks: [
                    {
                        type: "tool-result",
                        content,
                        meta: { toolName: name, isError },
                    },
                ],
            };
        }

        return { blocks: [] };
    }
}
