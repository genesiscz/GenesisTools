import { logger } from "@genesiscz/utils/logger";
import {
    type CallToolResult,
    type ListToolsResult,
    ProtocolError,
    ProtocolErrorCode,
    Server,
    type Tool,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { Fetcher } from "../lib/fetcher";
import { FETCH_TOOLS, toolText } from "./tools";

const { log } = logger.scoped("fetch-mcp");

const SERVER_NAME = "fetch";
const SERVER_VERSION = "1.0.0";
/** A resident server ends its idle Chrome sidecar after a minute; the next chrome request starts a new one. */
const IDLE_CLOSE_MS = 60_000;

function errorMessage(error: unknown): string {
    if (error instanceof z.ZodError) {
        return z.prettifyError(error);
    }

    return error instanceof Error ? error.message : String(error);
}

/** The `tools fetch mcp` server over one Fetcher; the caller owns the fetcher and closes it. */
export function createFetchServer(fetcher: Fetcher): Server {
    const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

    server.setRequestHandler(
        "tools/list",
        async (): Promise<ListToolsResult> => ({
            tools: FETCH_TOOLS.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: z.toJSONSchema(tool.schema, { io: "input" }) as Tool["inputSchema"],
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
            })),
        })
    );

    server.setRequestHandler("tools/call", async (request, context): Promise<CallToolResult> => {
        const tool = FETCH_TOOLS.find((candidate) => candidate.name === request.params.name);
        if (!tool) {
            throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }

        try {
            const result = await tool.run({
                fetcher,
                args: request.params.arguments ?? {},
                signal: context.mcpReq.signal,
            });
            return {
                content: [{ type: "text", text: toolText(result) }],
                _meta: {
                    source: result.source,
                    status: result.status,
                    transport: result.transport,
                    escalation: result.escalation,
                    tokens: result.tokens,
                    truncated: result.truncated,
                },
            };
        } catch (error) {
            log.warn({ error, tool: tool.name }, "fetch MCP tool call failed");
            return { isError: true, content: [{ type: "text", text: `Error: ${errorMessage(error)}` }] };
        }
    });

    return server;
}

/**
 * Serves until stdin ends. The stdio transport does not close on EOF, and the Chrome sidecar's pipes would keep the
 * process alive, so stdin's end closes the fetcher and the server explicitly.
 */
export async function startFetchMcpServer(): Promise<void> {
    const fetcher = new Fetcher({ idleCloseMs: IDLE_CLOSE_MS });
    const server = createFetchServer(fetcher);
    await server.connect(new StdioServerTransport());
    log.debug({ version: SERVER_VERSION, tools: FETCH_TOOLS.map((tool) => tool.name) }, "fetch MCP server running");

    process.stdin.once("end", () => {
        log.debug("fetch MCP server: stdin ended, closing");
        void fetcher.close().finally(() => server.close());
    });
}
