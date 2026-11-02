import { logger } from "@genesiscz/utils/logger";
import {
    type CallToolResult,
    type ListToolsResult,
    ProtocolError,
    ProtocolErrorCode,
    Server,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { WazeContextOptions } from "../lib/context";
import { createWazeToolset, WAZE_MCP_INSTRUCTIONS, type WazeMcpTool } from "./tools";

const SERVER_NAME = "waze";
const SERVER_VERSION = "1.0.0";

export function createWazeServer(tools: WazeMcpTool[]): Server {
    const server = new Server(
        { name: SERVER_NAME, version: SERVER_VERSION },
        { capabilities: { tools: {} }, instructions: WAZE_MCP_INSTRUCTIONS }
    );

    server.setRequestHandler(
        "tools/list",
        async (): Promise<ListToolsResult> => ({
            tools: tools.map(({ name, description, inputSchema, annotations }) => ({
                name,
                description,
                inputSchema,
                annotations,
            })),
        })
    );

    server.setRequestHandler("tools/call", async (request): Promise<CallToolResult> => {
        const tool = tools.find((candidate) => candidate.name === request.params.name);
        if (!tool) {
            throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }

        return tool.call(request.params.arguments ?? {});
    });

    return server;
}

/** The stdio server. The live-map tab it opens closes when the client closes stdin or sends SIGTERM. */
export async function startMcpServer(opts: WazeContextOptions = {}): Promise<void> {
    const toolset = createWazeToolset(opts);
    const server = createWazeServer(toolset.tools);
    let shuttingDown = false;
    const shutdown = async (reason: string): Promise<void> => {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;
        logger.debug({ reason }, "waze mcp server stopping");
        try {
            await toolset.close();
            await server.close();
        } finally {
            process.exit(0);
        }
    };

    await server.connect(new StdioServerTransport());
    // The CDP socket keeps the process alive, so the client closing stdin must end it explicitly.
    process.stdin.on("end", () => shutdown("stdin EOF"));
    process.stdin.on("close", () => shutdown("stdin close"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    logger.debug({ tools: toolset.tools.length }, "waze mcp server running");
}
