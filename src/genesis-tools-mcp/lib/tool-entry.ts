import type { CallToolResult } from "@modelcontextprotocol/server";

/**
 * What a registry handler answers: its text, or its text with the machine result an MCP client reads as
 * `structuredContent`. A tool whose usable data lives only in the structured result (ids, links, raw fields) answers
 * the object form, so the shared server hands out the same answer as the tool's own standalone server.
 */
export type ToolAnswer = string | { text: string; structuredContent?: CallToolResult["structuredContent"] };

export interface ToolEntry {
    description: string;
    inputSchema: Record<string, unknown>;
    /** Returns the answer. `context.signal` aborts when the client cancels the call. */
    handler: (args: Record<string, unknown>, context?: { signal?: AbortSignal }) => Promise<ToolAnswer>;
}

/** The text of a handler's answer. */
export function answerText(answer: ToolAnswer): string {
    return typeof answer === "string" ? answer : answer.text;
}

/** A handler's answer as the `tools/call` result the registry sends. */
export function toolCallResult(answer: ToolAnswer): CallToolResult {
    if (typeof answer === "string") {
        return { content: [{ type: "text", text: answer }] };
    }

    return {
        content: [{ type: "text", text: answer.text }],
        ...(answer.structuredContent ? { structuredContent: answer.structuredContent } : {}),
    };
}

/** A tool of a standalone MCP server, which already answers in MCP's own result shape. */
export interface McpServerTool {
    description: string;
    inputSchema: Record<string, unknown>;
    call(args: unknown): Promise<CallToolResult>;
}

function resultText(result: CallToolResult): string {
    return result.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .filter(Boolean)
        .join("\n");
}

/**
 * A standalone server's tool as a registry entry: the same `call`, its text and its structured result passed through
 * unchanged. An error result becomes a thrown error, which the registry reports as `isError`.
 */
export function entryFromMcpTool(tool: McpServerTool): ToolEntry {
    return {
        description: tool.description,
        inputSchema: tool.inputSchema,
        handler: async (args) => {
            const result = await tool.call(args);
            const text = resultText(result);
            if (result.isError) {
                throw new Error(text);
            }

            return result.structuredContent ? { text, structuredContent: result.structuredContent } : text;
        },
    };
}
