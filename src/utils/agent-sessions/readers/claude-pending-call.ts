import { isObject } from "@genesiscz/utils/object";
import { type PendingCallShape, pendingCallDetail } from "../pending-call";
import type { PendingToolCall } from "../types";

/** Claude Code tool names by the shape of their input. Any other tool shows its raw input. */
const CLAUDE_CALL_SHAPES: Readonly<Record<string, PendingCallShape>> = {
    Bash: "command",
    Edit: "replace",
    MultiEdit: "replace",
    Write: "write",
    ExitPlanMode: "plan",
};

/**
 * The newest `tool_use` of the records that no later `tool_result` answers. Measured on Claude Code 2.1.314
 * (2026-11-04 14:56): while a Bash permission or an ExitPlanMode plan dialog is open, the assistant record with the
 * `tool_use` is already written and nothing answers it yet.
 */
export function claudePendingCall(records: readonly Record<string, unknown>[]): PendingToolCall | null {
    const open = new Map<string, PendingToolCall>();

    for (const record of records) {
        const message = isObject(record.message) ? record.message : null;
        const content = Array.isArray(message?.content) ? message.content : [];
        const cwd = typeof record.cwd === "string" ? record.cwd : undefined;
        const at = typeof record.timestamp === "string" ? record.timestamp : undefined;

        for (const block of content) {
            if (!isObject(block)) {
                continue;
            }

            if (record.type === "assistant" && block.type === "tool_use" && typeof block.id === "string") {
                const tool = typeof block.name === "string" ? block.name : "tool";
                open.delete(block.id);
                open.set(block.id, {
                    callId: block.id,
                    tool,
                    ...(at ? { at } : {}),
                    detail: pendingCallDetail(CLAUDE_CALL_SHAPES[tool] ?? "tool", block.input, cwd),
                });
            } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
                open.delete(block.tool_use_id);
            }
        }
    }

    return [...open.values()].at(-1) ?? null;
}
