import type { NativeHistoryEntry } from "@genesiscz/utils/agent-sessions/types";

/** The tool names and paths a reader learns from tool calls, keyed by call id, for the results that follow. */
export interface ToolContext {
    names: Map<string, string>;
    paths: Map<string, string[]>;
}

export interface HistoryEntryInput {
    role: NativeHistoryEntry["role"];
    text: string;
    line: number;
    timestamp?: string;
    tool?: string;
    toolEvent?: "call" | "result";
    inputText?: string;
    searchText?: string;
    paths?: string[];
    callId?: string;
}

/** A reader's entry builder; `commitsOf` is the reader's own rule for the commit hashes a text names. */
export function historyEntryBuilder(
    commitsOf: (text: string) => string[]
): (options: HistoryEntryInput) => NativeHistoryEntry | undefined {
    return (options) => {
        if (!options.text && !options.searchText) {
            return;
        }

        return {
            line: options.line,
            role: options.role,
            text: options.text,
            ...(options.searchText ? { searchText: options.searchText } : {}),
            ...(options.tool ? { tool: options.tool } : {}),
            ...(options.toolEvent ? { toolEvent: options.toolEvent } : {}),
            ...(options.inputText ? { inputText: options.inputText } : {}),
            ...(options.callId ? { callId: options.callId } : {}),
            paths: options.paths ?? [],
            commits: commitsOf(options.text),
            ...(options.timestamp ? { timestamp: options.timestamp } : {}),
        };
    };
}

/** A transcript value as a plain record, or an empty one; the row-anchor walks read optional fields off it. */
export function anchorRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};
}

/** The non-empty strings among `values`. */
export function anchorStrings(values: unknown[]): string[] {
    return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}
