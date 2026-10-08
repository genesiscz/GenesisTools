import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type CallToolResult, Server, type Tool } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { commandSchema, ShowOnceService } from "./lib/service";

export function createShowOnceMcpServer(service = new ShowOnceService()): Server {
    const server = new Server({ name: "genesis-show-once", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", async () => ({
        tools: [
            {
                name: "show_once",
                description:
                    "Record, inspect, save or replay versioned browser/report-file workflows. Actions require an explicit tab and recipe. No automatic action retries. cancel stops owned waits; resume explicitly acknowledges the exact run checkpoint.",
                inputSchema: z.toJSONSchema(commandSchema, { io: "input" }) as Tool["inputSchema"],
                annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
            },
        ],
    }));
    server.setRequestHandler("tools/call", async (request, context): Promise<CallToolResult> => {
        if (request.params.name !== "show_once") {
            return { content: [{ type: "text", text: "Unknown tool." }], isError: true };
        }
        try {
            const result = await service.dispatch(request.params.arguments ?? {}, context.mcpReq.signal);
            const failed =
                result !== null && typeof result === "object" && "status" in result && result.status !== "completed";
            return { content: [{ type: "text", text: SafeJSON.stringify(result, { strict: true }) }], isError: failed };
        } catch (error) {
            logger.warn({ error }, "Show Once MCP request failed");
            return {
                content: [{ type: "text", text: error instanceof Error ? error.message : "Request failed." }],
                isError: true,
            };
        }
    });
    return server;
}
export async function startShowOnceMcpServer(): Promise<void> {
    const service = new ShowOnceService();
    const server = createShowOnceMcpServer(service);
    const stop = () => {
        void service.close().finally(() => server.close());
    };
    process.stdin.once("end", stop);
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    await server.connect(new StdioServerTransport());
}
