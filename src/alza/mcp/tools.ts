import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type AccountContext, openAccountContext } from "../lib/account";
import { ACCOUNT_OPERATIONS, type AccountOperationKind } from "../lib/account-operations";
import { ALZA_OPERATIONS, type OperationResult } from "../lib/operations";
import type { StorefrontId } from "../lib/storefront";

/**
 * Every Alza MCP tool, ready to mount on any MCP server: name, description, JSON input schema, annotations and a call
 * that returns a CallToolResult (errors included, never thrown). `tools alza mcp` serves this list; another server
 * (the genesis-tools MCP) can mount the same list through `createAlzaToolset`.
 */

export const ALZA_MCP_INSTRUCTIONS =
    "Alza.cz catalog and account (unofficial; not affiliated with Alza). Typical flow: autocomplete or search_products → " +
    "get_product → get_reviews / get_questions / price_history; compare_products for 2-6 candidates; list_categories → " +
    "list_category_filters → list_category for brand and parameter filters; get_deals for discounts; pc_build_check / " +
    "pc_build_suggest for PC parts. Account: account_status first; cart_*, favorites_list, mutate_list, delivery_options, " +
    "payment_methods, address_search, contacts and chat_navigation work without a sign-in (a visitor basket kept between " +
    "runs); orders_*, order_*, profile, gdpr_info, complaint_claims, claim_detail, subscription_overview and watchdog_* need " +
    `one. Sign-in is a browser step the user runs in a terminal: ${toolCommand("alza auth login")}. ` +
    "Nothing here places an order or pays. Products accept a code, a numeric id or a product URL.";

export interface AlzaMcpTool {
    name: string;
    description: string;
    inputSchema: Tool["inputSchema"];
    annotations: Tool["annotations"];
    call(args: unknown): Promise<CallToolResult>;
}

export interface AlzaToolsetOptions {
    /** Also list the raw read-only escape hatch (`mobile_read`). Off by default. */
    includeRaw?: boolean;
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

function toolFrom(def: {
    name: string;
    description: string;
    input: z.ZodObject;
    kind: AccountOperationKind;
    run(args: unknown): Promise<OperationResult>;
}): AlzaMcpTool {
    return {
        name: def.name,
        description: def.description,
        inputSchema: z.toJSONSchema(def.input, { io: "input" }) as Tool["inputSchema"],
        annotations: annotations(def.kind),
        call: async (args) => {
            const started = performance.now();
            try {
                const result = await def.run(args ?? {});
                logger.debug({ tool: def.name, ms: Math.round(performance.now() - started) }, "alza mcp tool");
                return {
                    content: [{ type: "text", text: result.markdown }],
                    structuredContent: { result: result.data },
                };
            } catch (error) {
                logger.warn({ error, tool: def.name }, "alza mcp tool failed");
                return { isError: true, content: [{ type: "text", text: `Error: ${errorMessage(error)}` }] };
            }
        },
    };
}

/** The catalog table and the account table over one account context. A non-diagnostic account call saves the visitor. */
export function alzaMcpTools(ctx: AccountContext, opts: AlzaToolsetOptions = {}): AlzaMcpTool[] {
    return [
        ...ALZA_OPERATIONS.map((op) => toolFrom({ ...op, kind: "read", run: (args) => op.run(ctx.api, args) })),
        ...ACCOUNT_OPERATIONS.filter((op) => opts.includeRaw || !op.hidden).map((op) =>
            toolFrom({
                ...op,
                run: async (args) => {
                    const result = await op.run(ctx, args);
                    if (op.kind !== "diagnostic") {
                        ctx.session.save();
                    }

                    return result;
                },
            })
        ),
    ];
}

export interface AlzaToolset {
    tools: AlzaMcpTool[];
    instructions: string;
    close(): Promise<void>;
}

/** A self-contained toolset for another MCP server: opens the account context, and closes it (and its sidecar) on close(). */
export function createAlzaToolset(opts: AlzaToolsetOptions & { storefront?: StorefrontId } = {}): AlzaToolset {
    const ctx = openAccountContext({ storefront: opts.storefront });
    return {
        tools: alzaMcpTools(ctx, opts),
        instructions: ALZA_MCP_INSTRUCTIONS,
        close: () => ctx.close({ save: false }),
    };
}
