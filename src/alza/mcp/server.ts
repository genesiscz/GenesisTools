import { logger } from "@genesiscz/utils/logger";
import {
    type CallToolResult,
    type ListToolsResult,
    ProtocolError,
    ProtocolErrorCode,
    Server,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { StorefrontId } from "../lib/storefront";
import { ALZA_MCP_INSTRUCTIONS, type AlzaMcpTool, createAlzaToolset } from "./tools";

const SERVER_NAME = "alza";
const SERVER_VERSION = "1.0.0";

export function createAlzaServer(tools: AlzaMcpTool[]): Server {
    const server = new Server(
        { name: SERVER_NAME, version: SERVER_VERSION },
        { capabilities: { tools: {} }, instructions: ALZA_MCP_INSTRUCTIONS }
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

export async function startMcpServer(opts: { storefront?: StorefrontId; includeRaw?: boolean } = {}): Promise<void> {
    const toolset = createAlzaToolset({ storefront: opts.storefront, includeRaw: opts.includeRaw });
    const server = createAlzaServer(toolset.tools);
    let shuttingDown = false;
    const shutdown = async (reason: string): Promise<void> => {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;
        logger.debug({ reason }, "alza mcp server stopping");
        try {
            await toolset.close();
            await server.close();
        } finally {
            process.exit(0);
        }
    };

    await server.connect(new StdioServerTransport());
    // The stdio transport does not close on EOF, so the client closing stdin must end the server explicitly.
    process.stdin.on("end", () => shutdown("stdin EOF"));
    process.stdin.on("close", () => shutdown("stdin close"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    logger.debug({ storefront: opts.storefront ?? "cz", tools: toolset.tools.length }, "alza mcp server running");
}
