import { getShopsDatabase, type ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { buildRegistry, getAdvertisedTools, getHandler, type ToolEntry } from "@app/shops/mcp/registry";
import { listResources, readResource } from "@app/shops/mcp/resources";
import { logger } from "@genesiscz/utils/logger";
import {
    type CallToolResult,
    type ListResourcesResult,
    type ListToolsResult,
    ProtocolError,
    ProtocolErrorCode,
    type ReadResourceResult,
    Server,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const log = logger.child({ component: "shops:mcp-server" });

export interface McpServerOptions {
    allowWrite: boolean;
    shopsDb?: ShopsDatabase;
}

export async function startMcpServer(options: McpServerOptions): Promise<void> {
    const shopsDb = options.shopsDb ?? getShopsDatabase();
    const registry = buildRegistry();
    const allowWrite = options.allowWrite;

    const server = new Server({ name: "shops", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });

    server.setRequestHandler(
        "tools/list",
        async (): Promise<ListToolsResult> => ({
            tools: getAdvertisedTools(registry, allowWrite).map((t: ToolEntry) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema as unknown as ListToolsResult["tools"][number]["inputSchema"],
            })),
        })
    );

    server.setRequestHandler("tools/call", async (request): Promise<CallToolResult> => {
        const name = request.params.name;
        const lookup = getHandler(registry, name, allowWrite);
        if (lookup.kind === "notFound") {
            throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }

        if (lookup.kind === "writeBlocked") {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Tool ${name} requires --allow-write flag. Re-run server with --allow-write to enable.`,
                    },
                ],
                isError: true,
            };
        }

        const args = (request.params.arguments ?? {}) as unknown;
        const result = await lookup.entry.handler(args, { shopsDb });
        return { content: result.content, isError: result.isError };
    });

    server.setRequestHandler(
        "resources/list",
        async (): Promise<ListResourcesResult> => ({
            resources: listResources().map((r) => ({
                uri: r.uri,
                name: r.name,
                mimeType: r.mimeType,
            })),
        })
    );

    server.setRequestHandler("resources/read", async (request): Promise<ReadResourceResult> => {
        const uri = request.params.uri;
        try {
            const content = await readResource(uri, shopsDb);
            return { contents: [content] };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(message);
        }
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info({ allowWrite, toolCount: getAdvertisedTools(registry, allowWrite).length }, "MCP server started");
}
