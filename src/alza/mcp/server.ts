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
import { AlzaApi } from "../lib/api";
import { ALZA_OPERATIONS } from "../lib/operations";
import type { StorefrontId } from "../lib/storefront";

const SERVER_NAME = "alza";
const SERVER_VERSION = "1.0.0";

const INSTRUCTIONS =
    "Alza.cz catalog (unofficial; not affiliated with Alza). Typical flow: autocomplete or search_products → " +
    "get_product → get_reviews / get_questions / price_history; compare_products for 2-6 candidates; " +
    "list_category_filters → list_category for brand and parameter filters; get_deals for discounts. " +
    "Products accept a code, a numeric id or a product URL.";

function errorMessage(error: unknown): string {
    if (error instanceof z.ZodError) {
        return z.prettifyError(error);
    }

    return error instanceof Error ? error.message : String(error);
}

export function createAlzaServer(api: AlzaApi): Server {
    const server = new Server(
        { name: SERVER_NAME, version: SERVER_VERSION },
        { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
    );

    server.setRequestHandler(
        "tools/list",
        async (): Promise<ListToolsResult> => ({
            tools: ALZA_OPERATIONS.map((op) => ({
                name: op.name,
                description: op.description,
                inputSchema: z.toJSONSchema(op.input, { io: "input" }) as Tool["inputSchema"],
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
            })),
        })
    );

    server.setRequestHandler("tools/call", async (request): Promise<CallToolResult> => {
        const op = ALZA_OPERATIONS.find((candidate) => candidate.name === request.params.name);
        if (!op) {
            throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }

        const started = performance.now();
        try {
            const result = await op.run(api, request.params.arguments ?? {});
            logger.debug({ tool: op.name, ms: Math.round(performance.now() - started) }, "alza mcp tool");
            return {
                content: [{ type: "text", text: result.markdown }],
                structuredContent: { result: result.data },
            };
        } catch (error) {
            logger.warn({ error, tool: op.name }, "alza mcp tool failed");
            return { isError: true, content: [{ type: "text", text: `Error: ${errorMessage(error)}` }] };
        }
    });

    return server;
}

export async function startMcpServer(opts: { storefront?: StorefrontId } = {}): Promise<void> {
    const api = new AlzaApi({ storefront: opts.storefront });
    const server = createAlzaServer(api);
    let shuttingDown = false;
    const shutdown = async (reason: string): Promise<void> => {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;
        logger.debug({ reason }, "alza mcp server stopping");
        try {
            await api.close();
            await server.close();
        } finally {
            process.exit(0);
        }
    };

    await server.connect(new StdioServerTransport());
    // The sidecar's pipes keep the process alive, so the client closing stdin must end it explicitly.
    process.stdin.on("end", () => shutdown("stdin EOF"));
    process.stdin.on("close", () => shutdown("stdin close"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    logger.debug({ storefront: api.storefront.id, tools: ALZA_OPERATIONS.length }, "alza mcp server running");
}
