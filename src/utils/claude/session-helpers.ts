import { SafeJSON } from "@app/utils/json";
import { truncateText } from "@app/utils/string";
import type { ConversationMessage, TextBlock, ToolResultBlock, ToolUseBlock } from "./types";

/** Shorthand "A" variant that some JSONL sessions use for assistant messages. */
interface ShorthandAssistant {
    type: "A";
    message?: { stop_reason?: string | null };
}

export function extractToolInputSummary(tool: ToolUseBlock): string {
    const input = tool.input;

    if ("command" in input && typeof input.command === "string") {
        return input.command;
    }

    if ("file_path" in input && typeof input.file_path === "string") {
        return input.file_path;
    }

    if ("pattern" in input && typeof input.pattern === "string") {
        return input.pattern;
    }

    if ("description" in input && typeof input.description === "string") {
        return input.description;
    }

    if ("query" in input && typeof input.query === "string") {
        return input.query;
    }

    if ("skill" in input && typeof input.skill === "string") {
        return input.skill;
    }

    const safeInput = SafeJSON.stringify(input);
    return safeInput;
}

const PRIMARY_PARAMS: Record<string, string> = {
    Bash: "command",
    Read: "file_path",
    Edit: "file_path",
    Write: "file_path",
    MultiEdit: "file_path",
    Grep: "pattern",
    Glob: "pattern",
    Agent: "description",
    Skill: "skill",
    WebFetch: "url",
    WebSearch: "query",
    NotebookEdit: "notebook_path",
};

const SKIP_PARAMS = new Set([
    "old_string",
    "new_string",
    "content",
    "prompt",
    "replace_all",
    "dangerouslyDisableSandbox",
    "run_in_background",
]);

/**
 * Format a tool call as a function-call signature: `Bash(git log --oneline)`.
 * Primary param is positional; other non-skipped params shown as `key: value`.
 */
export function formatToolCallSignature(tool: ToolUseBlock, maxPrimaryChars: number): string {
    const { name, input } = tool;
    const primaryKey = PRIMARY_PARAMS[name];
    const rawPrimary = primaryKey && primaryKey in input ? input[primaryKey] : null;
    const primary = rawPrimary != null && rawPrimary !== "" ? String(rawPrimary) : null;

    const parts: string[] = [];

    if (primary) {
        parts.push(truncateText(primary, maxPrimaryChars));
    }

    for (const [k, v] of Object.entries(input)) {
        if (k === primaryKey || SKIP_PARAMS.has(k)) {
            continue;
        }

        if (v === undefined || v === null || v === false) {
            continue;
        }

        if (v === true) {
            parts.push(k);
            continue;
        }

        const val = typeof v === "string" ? truncateText(v, 60) : String(v);
        parts.push(`${k}: ${val}`);
    }

    return `${name}(${parts.join(", ")})`;
}

/**
 * For Edit/Write/MultiEdit, render old_string → new_string as a diff block.
 * Returns null if the tool has no diff content or the char budget is too low.
 */
export function formatToolCallDiffBlock(tool: ToolUseBlock, maxChars: number): string | null {
    if (maxChars <= 500) {
        return null;
    }

    const { name, input } = tool;

    if (name === "Edit" || name === "MultiEdit") {
        const old = input.old_string as string | undefined;
        const new_ = input.new_string as string | undefined;

        if (!old && !new_) {
            return null;
        }

        const halfBudget = Math.floor(maxChars / 2);
        const lines: string[] = [];

        if (old) {
            const truncated = truncateText(old, halfBudget);

            for (const l of truncated.split("\n")) {
                lines.push(`- ${l}`);
            }
        }

        if (new_) {
            const truncated = truncateText(new_, halfBudget);

            for (const l of truncated.split("\n")) {
                lines.push(`+ ${l}`);
            }
        }

        return lines.join("\n");
    }

    if (name === "Write") {
        const content = input.content as string | undefined;

        if (!content) {
            return null;
        }

        return truncateText(content, maxChars);
    }

    return null;
}

export function extractToolResultText(block: ToolResultBlock): string {
    if (typeof block.content === "string") {
        return block.content;
    }

    if (Array.isArray(block.content)) {
        return block.content
            .filter((b): b is TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n");
    }

    return "";
}

export function isAssistantEndTurn(record: ConversationMessage): boolean {
    if (record.type === "assistant") {
        return record.message?.stop_reason === "end_turn";
    }

    const raw = record as unknown as ShorthandAssistant;

    if (raw.type !== "A") {
        return false;
    }

    return raw.message?.stop_reason === "end_turn";
}
