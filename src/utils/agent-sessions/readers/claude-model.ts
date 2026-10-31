/** Claude's `currentModel`: the newest assistant row of the session's own chain names it. */
import { SafeJSON } from "@genesiscz/utils/json";
import { isClaudeSubagentPath } from "./claude-subagent-path";
import { newestModelInTail, type RowModel } from "./session-model";

/**
 * The model one Claude row names: an assistant row's `message.model`. Harness notices carry `<synthetic>`, and an
 * Agent `tool_use` input names the sub-agent's model, so neither counts.
 */
export function claudeModelOfRow(row: string): RowModel | undefined {
    if (!row.includes('"assistant"') || !row.includes('"model"')) {
        return undefined;
    }

    let value: unknown;

    try {
        value = SafeJSON.parse(row, { strict: true });
    } catch {
        // The tail's first row is cut by the window, and a row being written is cut too: neither names a model.
        return undefined;
    }

    if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "assistant") {
        return undefined;
    }

    const message = "message" in value ? value.message : undefined;
    const model = typeof message === "object" && message !== null && "model" in message ? message.model : undefined;

    if (typeof model !== "string" || !model || model.startsWith("<")) {
        return undefined;
    }

    return { model, sidechain: "isSidechain" in value && value.isSidechain === true };
}

/**
 * The model a Claude session (or a sub-agent's own transcript) runs now, from the tail of its transcript. Side-chain
 * rows count only in a sub-agent's own transcript; a parent whose own chain left the tail has no known model, so the
 * guard judges it as a session with no model rather than by a sub-agent's.
 */
export function claudeCurrentModel(transcriptPath: string): string | null {
    return newestModelInTail(transcriptPath, claudeModelOfRow, {
        acceptSidechain: isClaudeSubagentPath(transcriptPath),
    });
}
