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
import { type AccountContext, openAccountContext } from "../lib/account";
import { ACCOUNT_OPERATIONS, type AccountOperationKind } from "../lib/account-operations";
import { ALZA_OPERATIONS, type OperationResult } from "../lib/operations";
import type { StorefrontId } from "../lib/storefront";

const SERVER_NAME = "alza";
const SERVER_VERSION = "1.0.0";

const INSTRUCTIONS =
    "Alza.cz catalog and account (unofficial; not affiliated with Alza). Typical flow: autocomplete or search_products → " +
    "get_product → get_reviews / get_questions / price_history; compare_products for 2-6 candidates; " +
    "list_category_filters → list_category for brand and parameter filters; get_deals for discounts. " +
    "Account: account_status first; cart_show / cart_add / cart_remove and favorites_list work without a sign-in " +
    "(a visitor basket kept between runs); orders_list, order_show and watchdog_* need one. Sign-in is a browser step the " +
    "user runs in a terminal: tools alza auth login. Nothing here places an order or pays. " +
    "Products accept a code, a numeric id or a product URL.";

/** Both tables as one tool list. A catalog tool only reads; an account tool says what it does. */
interface McpTool {
    name: string;
    description: string;
    input: z.ZodObject;
    kind: AccountOperationKind;
    call(args: unknown): Promise<OperationResult>;
}

function mcpTools(ctx: AccountContext): McpTool[] {
    return [
        ...ALZA_OPERATIONS.map((op) => ({
            ...op,
            kind: "read" as const,
            call: (args: unknown) => op.run(ctx.api, args),
        })),
        ...ACCOUNT_OPERATIONS.map((op) => ({
            ...op,
            call: async (args: unknown) => {
                const result = await op.run(ctx, args);
                if (op.kind !== "diagnostic") {
                    ctx.session.save();
                }

                return result;
            },
        })),
    ];
}

function annotations(kind: AccountOperationKind): Tool["annotations"] {
    if (kind === "write") {
        return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
    }

    return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
}

function errorMessage(error: unknown): string {
    if (error instanceof z.ZodError) {
        return z.prettifyError(error);
    }

    return error instanceof Error ? error.message : String(error);
}

export function createAlzaServer(ctx: AccountContext): Server {
    const tools = mcpTools(ctx);
    const server = new Server(
        { name: SERVER_NAME, version: SERVER_VERSION },
        { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
    );

    server.setRequestHandler(
        "tools/list",
        async (): Promise<ListToolsResult> => ({
            tools: tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: z.toJSONSchema(tool.input, { io: "input" }) as Tool["inputSchema"],
                annotations: annotations(tool.kind),
            })),
        })
    );

    server.setRequestHandler("tools/call", async (request): Promise<CallToolResult> => {
        const op = tools.find((candidate) => candidate.name === request.params.name);
        if (!op) {
            throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }

        const started = performance.now();
        try {
            const result = await op.call(request.params.arguments ?? {});
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
    const ctx = openAccountContext({ storefront: opts.storefront });
    const server = createAlzaServer(ctx);
    let shuttingDown = false;
    const shutdown = async (reason: string): Promise<void> => {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;
        logger.debug({ reason }, "alza mcp server stopping");
        try {
            await ctx.close({ save: false });
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
    logger.debug(
        { storefront: ctx.api.storefront.id, tools: ALZA_OPERATIONS.length + ACCOUNT_OPERATIONS.length },
        "alza mcp server running"
    );
}
