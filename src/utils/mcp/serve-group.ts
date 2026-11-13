import { logger } from "@genesiscz/utils/logger";
import {
    type CallToolResult,
    type ListToolsResult,
    ProtocolError,
    ProtocolErrorCode,
    Server,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { serveStdio } from "./stdio";
import { toolCallResult } from "./tool-entry";
import type { ToolGroupRow } from "./tool-group";

const { log } = logger.scoped("mcp-group");

function errorMessage(error: unknown): string {
    if (error instanceof z.ZodError) {
        return z.prettifyError(error);
    }

    return error instanceof Error ? error.message : String(error);
}

/**
 * Serves one tool group alone on stdio (`tools alza mcp`, `tools waze mcp`, `tools fetch mcp`), its tools under the
 * names its entries carry: a standalone row loads its group with the names that door's clients already know. stdin's
 * end, SIGINT and SIGTERM close what the group holds, then the process exits.
 */
export async function serveToolGroup(
    row: ToolGroupRow,
    info: { name: string; version: string; instructions?: string }
): Promise<void> {
    const group = await row.load();
    const tools = new Map(Object.entries(group.entries));
    const server = new Server(
        { name: info.name, version: info.version },
        { capabilities: { tools: {} }, ...(info.instructions ? { instructions: info.instructions } : {}) }
    );

    server.setRequestHandler(
        "tools/list",
        async (): Promise<ListToolsResult> => ({
            tools: [...tools].map(([name, entry]) => ({
                name,
                description: entry.description,
                inputSchema: entry.inputSchema as ListToolsResult["tools"][number]["inputSchema"],
                ...(entry.annotations ? { annotations: entry.annotations } : {}),
            })),
        })
    );

    server.setRequestHandler("tools/call", async (request, context): Promise<CallToolResult> => {
        const entry = tools.get(request.params.name);
        if (!entry) {
            throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }

        try {
            const answer = await entry.handler((request.params.arguments ?? {}) as Record<string, unknown>, {
                signal: context.mcpReq.signal,
            });
            return toolCallResult(answer);
        } catch (error) {
            // A standalone tool's own error result already reads "Error: …" (entryFromMcpTool threw its text).
            const message = errorMessage(error);
            const text = message.startsWith("Error: ") ? message : `Error: ${message}`;
            log.warn({ error, server: info.name, tool: request.params.name }, "MCP group tool call failed");
            return { isError: true, content: [{ type: "text", text }] };
        }
    });

    await serveStdio({
        name: info.name,
        server,
        transport: new StdioServerTransport(),
        shutdown: async () => {
            await group.close?.();
            await server.close();
        },
    });
    log.debug({ server: info.name, tools: [...tools.keys()] }, "MCP group server running");
}
