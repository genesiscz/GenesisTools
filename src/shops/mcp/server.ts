import logger from "@app/logger";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getShopsDatabase, type ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { buildRegistry, getAdvertisedTools, getHandler, type ToolEntry } from "@app/shops/mcp/registry";
import { listResources, readResource } from "@app/shops/mcp/resources";

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

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: getAdvertisedTools(registry, allowWrite).map((t: ToolEntry) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
        })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = request.params.name;
        const lookup = getHandler(registry, name, allowWrite);
        if (lookup.kind === "notFound") {
            return {
                content: [{ type: "text", text: `Unknown tool: ${name}` }],
                isError: true,
            };
        }

        if (lookup.kind === "writeBlocked") {
            return {
                content: [
                    {
                        type: "text",
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

    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: listResources().map((r) => ({
            uri: r.uri,
            name: r.name,
            mimeType: r.mimeType,
        })),
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
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
