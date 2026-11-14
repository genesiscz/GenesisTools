import type { ToolCallsRead } from "../types";

/**
 * Grok's `readToolCalls`. Its chat history rows carry no time, so no call could be timed, and its Bash pre phase
 * never captures (Grok cannot render a diff: `grokHooks.rendersAnsiDiffs` is false), so no hook asks for its calls.
 * It says so instead of answering an empty list that would read as "this session called no tool".
 */
export function grokToolCalls(): ToolCallsRead {
    return {
        supported: false,
        reason: "Grok's chat history carries no time per row, and no Grok hook reads its tool calls incrementally",
    };
}
