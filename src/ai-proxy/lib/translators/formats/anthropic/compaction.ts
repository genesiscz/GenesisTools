import { isObject } from "@genesiscz/utils/object";

/**
 * How Claude Code's compaction prompt opens. It keeps the agent's tools in the request (cache reuse) and forbids them
 * in words only. Present in the Claude Code 2.1.296 binary (checked 2026-10-25); switcheroo keys on the same text.
 */
export const CLAUDE_CODE_COMPACTION_MARK = "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.";

function textOf(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .map((block) => (isObject(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
        .join("\n");
}

/** A Claude Code compaction turn: the request ends on a user message carrying the compaction prompt. */
export function isClaudeCodeCompactionTurn(body: { messages?: unknown }): boolean {
    const last = Array.isArray(body.messages) ? body.messages.at(-1) : undefined;
    return isObject(last) && last.role === "user" && textOf(last.content).includes(CLAUDE_CODE_COMPACTION_MARK);
}
