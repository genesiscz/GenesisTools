import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";

// MCP runs as the seeded local user (migration 003 inserts user id=1).
const MCP_USER_ID = 1;

import { getCoverage } from "@app/shops/lib/coverage-api";
import { ingestUrl } from "@app/shops/lib/ingest-api";
import { acceptCandidatePair } from "@app/shops/lib/match-api";
import { comparePrices, getProduct, listCategories, matchProduct } from "@app/shops/lib/product-api";
import { searchProducts } from "@app/shops/lib/search-api";
import {
    ackNotification,
    addFavorite,
    getRecentNotifications,
    getWatchlist,
    removeFavorite,
} from "@app/shops/lib/watchlist-api";
import {
    type JsonSchema,
    ShopsAcceptMatchInput,
    ShopsAcceptMatchInputJsonSchema,
    ShopsComparePricesInput,
    ShopsComparePricesInputJsonSchema,
    ShopsCoverageInput,
    ShopsCoverageInputJsonSchema,
    ShopsGetProductInput,
    ShopsGetProductInputJsonSchema,
    ShopsIngestInput,
    ShopsIngestInputJsonSchema,
    ShopsListCategoriesInput,
    ShopsListCategoriesInputJsonSchema,
    ShopsMatchProductInput,
    ShopsMatchProductInputJsonSchema,
    ShopsNotifyAckInput,
    ShopsNotifyAckInputJsonSchema,
    ShopsRecentNotificationsInput,
    ShopsRecentNotificationsInputJsonSchema,
    ShopsSearchInput,
    ShopsSearchInputJsonSchema,
    ShopsWatchAddInput,
    ShopsWatchAddInputJsonSchema,
    ShopsWatchListInput,
    ShopsWatchListInputJsonSchema,
    ShopsWatchRemoveInput,
    ShopsWatchRemoveInputJsonSchema,
} from "@app/shops/mcp/types";
import { SafeJSON } from "@app/utils/json";

export interface HandlerContext {
    shopsDb: ShopsDatabase;
}

export interface HandlerResult {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
}

export type Handler = (args: unknown, ctx: HandlerContext) => Promise<HandlerResult>;

export interface ToolEntry {
    name: string;
    description: string;
    inputSchema: JsonSchema;
    handler: Handler;
    requiresWrite: boolean;
}

function jsonResult(payload: unknown): HandlerResult {
    return { content: [{ type: "text", text: SafeJSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string): HandlerResult {
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

async function safeRun(fn: () => Promise<HandlerResult>): Promise<HandlerResult> {
    try {
        return await fn();
    } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
    }
}

export function buildRegistry(): ToolEntry[] {
    return [
        {
            name: "shops_get_product",
            description: "Fetch a product by URL or {shop, slug}; includes price history + cross-shop matches.",
            inputSchema: ShopsGetProductInputJsonSchema,
            requiresWrite: false,
            handler: (args, ctx) =>
                safeRun(async () => {
                    const parsed = ShopsGetProductInput.parse(args);
                    return jsonResult(await getProduct(parsed, { shopsDb: ctx.shopsDb }));
                }),
        },
        {
            name: "shops_match_product",
            description: "Return cross-shop matches for the master of a given product URL.",
            inputSchema: ShopsMatchProductInputJsonSchema,
            requiresWrite: false,
            handler: (args, ctx) =>
                safeRun(async () => {
                    const parsed = ShopsMatchProductInput.parse(args);
                    return jsonResult(await matchProduct(parsed, { shopsDb: ctx.shopsDb }));
                }),
        },
        {
            name: "shops_search",
            description: "Free-text product search via FTS5 (diacritic-insensitive).",
            inputSchema: ShopsSearchInputJsonSchema,
            requiresWrite: false,
            handler: (args, ctx) =>
                safeRun(async () => {
                    const parsed = ShopsSearchInput.parse(args);
                    return jsonResult(await searchProducts(parsed, { shopsDb: ctx.shopsDb }));
                }),
        },
        {
            name: "shops_list_categories",
            description: "Return the category tree for a single shop origin.",
            inputSchema: ShopsListCategoriesInputJsonSchema,
            requiresWrite: false,
            handler: (args, ctx) =>
                safeRun(async () => {
                    const parsed = ShopsListCategoriesInput.parse(args);
                    return jsonResult(await listCategories(parsed, { shopsDb: ctx.shopsDb }));
                }),
        },
        {
            name: "shops_compare_prices",
            description: "Side-by-side current offers + history-point counts for 1-50 master ids.",
            inputSchema: ShopsComparePricesInputJsonSchema,
            requiresWrite: false,
            handler: (args, ctx) =>
                safeRun(async () => {
                    const parsed = ShopsComparePricesInput.parse(args);
                    return jsonResult(await comparePrices(parsed, { shopsDb: ctx.shopsDb }));
                }),
        },
        {
            name: "shops_coverage",
            description: "Per-shop product counts + capability flags + crawler health stats.",
            inputSchema: ShopsCoverageInputJsonSchema,
            requiresWrite: false,
            handler: (args, ctx) =>
                safeRun(async () => {
                    ShopsCoverageInput.parse(args);
                    return jsonResult(await getCoverage({ shopsDb: ctx.shopsDb }));
                }),
        },
        {
            name: "shops_watch_list",
            description: "Active watchlist favorites with current best price + threshold deltas.",
            inputSchema: ShopsWatchListInputJsonSchema,
            requiresWrite: false,
            handler: (args, _ctx) =>
                safeRun(async () => {
                    ShopsWatchListInput.parse(args);
                    return jsonResult(await getWatchlist(MCP_USER_ID));
                }),
        },
        {
            name: "shops_recent_notifications",
            description: "Recent fired notifications, optionally filtered by since-timestamp.",
            inputSchema: ShopsRecentNotificationsInputJsonSchema,
            requiresWrite: false,
            handler: (args, _ctx) =>
                safeRun(async () => {
                    const parsed = ShopsRecentNotificationsInput.parse(args);
                    const rows = await getRecentNotifications(MCP_USER_ID, { limit: parsed.limit });
                    if (parsed.since) {
                        const cutoff = parsed.since;
                        return jsonResult(rows.filter((r) => r.fired_at >= cutoff));
                    }

                    return jsonResult(rows);
                }),
        },
        {
            name: "shops_ingest",
            description: "Ingest a product URL into the local DB (writes products + prices + master).",
            inputSchema: ShopsIngestInputJsonSchema,
            requiresWrite: true,
            handler: (args, ctx) =>
                safeRun(async () => {
                    const parsed = ShopsIngestInput.parse(args);
                    return jsonResult(await ingestUrl(parsed, { shopsDb: ctx.shopsDb }));
                }),
        },
        {
            name: "shops_accept_match",
            description: "Accept a gray-zone candidate pair; merges masters if needed.",
            inputSchema: ShopsAcceptMatchInputJsonSchema,
            requiresWrite: true,
            handler: (args, ctx) =>
                safeRun(async () => {
                    const parsed = ShopsAcceptMatchInput.parse(args);
                    await acceptCandidatePair({
                        shopsDb: ctx.shopsDb,
                        productIdA: parsed.productIdA,
                        productIdB: parsed.productIdB,
                    });
                    return jsonResult({ ok: true, merged: true });
                }),
        },
        {
            name: "shops_watch_add",
            description: "Add a URL to the watchlist with optional price thresholds.",
            inputSchema: ShopsWatchAddInputJsonSchema,
            requiresWrite: true,
            handler: (args, _ctx) =>
                safeRun(async () => {
                    const parsed = ShopsWatchAddInput.parse(args);
                    return jsonResult(await addFavorite(MCP_USER_ID, parsed));
                }),
        },
        {
            name: "shops_watch_remove",
            description: "Remove a watchlist favorite by id.",
            inputSchema: ShopsWatchRemoveInputJsonSchema,
            requiresWrite: true,
            handler: (args, _ctx) =>
                safeRun(async () => {
                    const parsed = ShopsWatchRemoveInput.parse(args);
                    await removeFavorite(MCP_USER_ID, parsed.id);
                    return jsonResult({ ok: true });
                }),
        },
        {
            name: "shops_notify_ack",
            description: "Acknowledge a notification by id.",
            inputSchema: ShopsNotifyAckInputJsonSchema,
            requiresWrite: true,
            handler: (args, _ctx) =>
                safeRun(async () => {
                    const parsed = ShopsNotifyAckInput.parse(args);
                    await ackNotification(MCP_USER_ID, parsed.id);
                    return jsonResult({ ok: true });
                }),
        },
    ];
}

export function getAdvertisedTools(registry: ToolEntry[], allowWrite: boolean): ToolEntry[] {
    return allowWrite ? registry : registry.filter((t) => !t.requiresWrite);
}

export type LookupResult =
    | { kind: "ok"; entry: ToolEntry }
    | { kind: "writeBlocked"; entry: ToolEntry }
    | { kind: "notFound" };

export function getHandler(registry: ToolEntry[], name: string, allowWrite: boolean): LookupResult {
    const entry = registry.find((t) => t.name === name);
    if (!entry) {
        return { kind: "notFound" };
    }

    if (entry.requiresWrite && !allowWrite) {
        return { kind: "writeBlocked", entry };
    }

    return { kind: "ok", entry };
}
