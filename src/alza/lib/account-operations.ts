import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { z } from "zod";
import {
    type AccountContext,
    type AccountStatus,
    accountStatus,
    addToCart,
    addWatchdog,
    type CartView,
    type FavoritesView,
    listFavorites,
    listOrders,
    listWatchdogs,
    type OrderSummary,
    removeFromCart,
    removeWatchdog,
    showCart,
    showOrder,
    type Watchdog,
} from "./account";
import { AlzaApiError } from "./api";
import { NotSignedInError, SIGN_IN_HINT } from "./auth";
import { money } from "./format";
import type { OperationResult } from "./operations";

/**
 * The account features, once: the MCP server lists this table beside the catalog table, and the `auth`, `cart`,
 * `orders`, `watchdog` and `favorites` commands call the same entries. Sign-in itself is CLI-only (it needs a browser).
 */

/** `write` changes the basket or the account; `diagnostic` must not change anything, not even the visitor state. */
export type AccountOperationKind = "read" | "write" | "diagnostic";

export interface AccountOperation {
    name: string;
    description: string;
    input: z.ZodObject;
    kind: AccountOperationKind;
    run(ctx: AccountContext, args: unknown): Promise<OperationResult>;
}

/** A 401 on an account route is a sign-in problem, not a crash: say how to fix it. */
function signInErrors(error: unknown): never {
    if (error instanceof AlzaApiError && error.status === 401) {
        throw new NotSignedInError(`${error.message}. ${SIGN_IN_HINT}`);
    }

    throw error;
}

function accountOperation<S extends z.ZodObject>(def: {
    name: string;
    description: string;
    input: S;
    kind: AccountOperationKind;
    run(ctx: AccountContext, input: z.infer<S>): Promise<OperationResult>;
}): AccountOperation {
    return { ...def, run: (ctx, args) => def.run(ctx, def.input.parse(args)).catch(signInErrors) };
}

const product = z
    .string()
    .min(1)
    .describe("Product code (AUPR65708), numeric id (9383715) or product URL (…-d9383715.htm)");

// ── markdown ─────────────────────────────────────────────────────────────────

export function statusMarkdown(s: AccountStatus): string {
    if (!s.signedIn) {
        return `Not signed in. ${SIGN_IN_HINT}\n\nThe basket and favourites still work for the anonymous visitor ${s.visitorId}.`;
    }

    const lines = [
        "**Signed in**",
        `- Access token: ${s.expired ? "expired" : "valid"}${s.expiresAt ? ` (until ${s.expiresAt})` : ""}`,
        `- Refresh token: ${s.hasRefreshToken ? "present" : "missing"}`,
    ];
    if (s.userId) {
        lines.push(`- Alza user id: ${s.userId}`);
    }

    if (s.check) {
        lines.push(`- Check: ${s.check.ok ? "ok" : "failed"}. ${s.check.detail}`);
    }

    if (s.check?.userName) {
        lines.push(`- Name: ${s.check.userName}`);
    }

    return lines.join("\n");
}

export function cartMarkdown(cart: CartView): string {
    const who = cart.signedIn ? "account basket" : "visitor basket (not signed in)";
    if (cart.items.length === 0) {
        return `The ${who} is empty.`;
    }

    const lines = cart.items.map(
        (item) =>
            `- ${item.quantity}× **${item.name}** \`${item.code ?? item.productId ?? item.orderItemId}\` ${money(item.lineTotal, cart.currency)}${item.availability ? ` · ${item.availability}` : ""}`
    );
    return [
        `**${cart.itemCount} item(s) in the ${who}**`,
        ...lines,
        `Total: **${money(cart.total, cart.currency)}**`,
    ].join("\n");
}

export function favoritesMarkdown(f: FavoritesView): string {
    if (f.lists.every((list) => list.items.length === 0)) {
        return `No favourites${f.signedIn ? "" : " for the anonymous visitor (not signed in)"}.`;
    }

    return f.lists
        .map((list) =>
            [
                `**${list.name}** (${list.count})`,
                ...list.items.map(
                    (item) =>
                        `- **${item.name ?? item.id}** \`${item.code ?? item.id}\` ${money(item.price, f.currency)}${item.availability ? ` · ${item.availability}` : ""}`
                ),
            ].join("\n")
        )
        .join("\n\n");
}

function orderLine(order: OrderSummary): string {
    const bits = [order.created?.slice(0, 10), order.status, order.total].filter(Boolean).join(" · ");
    return `- **${order.number ?? order.id}**${order.list ? ` (${order.list})` : ""}${bits ? ` ${bits}` : ""}`;
}

export function ordersMarkdown(r: { orders: OrderSummary[]; hasMoreArchive: boolean }): string {
    if (r.orders.length === 0) {
        return "No orders.";
    }

    return [...r.orders.map(orderLine), r.hasMoreArchive ? "More archived orders exist (raise --limit)." : ""]
        .filter(Boolean)
        .join("\n");
}

export function orderMarkdown(order: OrderSummary): string {
    const lines = [`**${order.name ?? `Order ${order.number ?? order.id}`}**`];
    if (order.created) {
        lines.push(`- Created: ${order.created}`);
    }

    if (order.status) {
        lines.push(`- Status: ${order.status}`);
    }

    if (order.total) {
        lines.push(`- Total: ${order.total}`);
    }

    for (const part of order.parts) {
        lines.push(`- Part ${part.number ?? ""}${part.name ? ` ${part.name}` : ""}: ${part.status ?? "?"}`);
    }

    lines.push("", "The full answer is in `--json` (`raw`).");
    return lines.join("\n");
}

export function watchdogsMarkdown(
    r: { items: Watchdog[]; hasMore: boolean; empty?: string },
    currency: string
): string {
    if (r.items.length === 0) {
        return r.empty ?? "No watchdogs.";
    }

    return r.items
        .map((w) => {
            const watching = [
                w.maxPrice !== undefined ? `price below ${money(w.maxPrice, currency)}` : "",
                w.trackingStock ? "back in stock" : "",
            ]
                .filter(Boolean)
                .join(" or ");
            return `- **${w.name ?? w.productId}** now ${money(w.currentPrice, currency)}${w.availability ? ` · ${w.availability}` : ""}; alert on ${watching || "?"} \`${w.id ?? "?"}\``;
        })
        .join("\n");
}

// ── the table ────────────────────────────────────────────────────────────────

export const ACCOUNT_OPERATIONS: AccountOperation[] = [
    accountOperation({
        name: "account_status",
        description:
            "Is an Alza account signed in: token expiry, refresh token, user id, and one read-only check that Alza accepts the token. Never renews or changes anything. Sign in with the CLI: " +
            `${toolCommand("alza auth login")}.`,
        input: z.object({}),
        kind: "diagnostic",
        run: async (ctx) => {
            const data = await accountStatus(ctx);
            return { data, markdown: statusMarkdown(data) };
        },
    }),
    accountOperation({
        name: "cart_show",
        description:
            "The basket: products, quantities, prices and the total. The signed-in account's basket, or the anonymous visitor basket that this tool keeps between runs.",
        input: z.object({}),
        kind: "read",
        run: async (ctx) => {
            const data = await showCart(ctx);
            return { data, markdown: cartMarkdown(data) };
        },
    }),
    accountOperation({
        name: "cart_add",
        description: "Add a product to the basket (signed in or as the visitor). Does not order anything.",
        input: z.object({
            product,
            quantity: z.number().int().min(1).max(99).optional().describe("How many (default 1)"),
        }),
        kind: "write",
        run: async (ctx, i) => {
            const data = await addToCart(ctx, { product: i.product, quantity: i.quantity ?? 1 });
            return {
                data,
                markdown: `Added ${data.added.quantity}× ${data.added.name ?? data.added.code}.\n\n${cartMarkdown(data.cart)}`,
            };
        },
    }),
    accountOperation({
        name: "cart_remove",
        description: "Remove a product from the basket, whatever its quantity.",
        input: z.object({ product }),
        kind: "write",
        run: async (ctx, i) => {
            const data = await removeFromCart(ctx, { product: i.product });
            return {
                data,
                markdown: `Removed ${data.removed.name}.\n\n${cartMarkdown(data.cart)}`,
            };
        },
    }),
    accountOperation({
        name: "favorites_list",
        description: "The products in the Oblíbené (favourites) list, with prices and stock.",
        input: z.object({}),
        kind: "read",
        run: async (ctx) => {
            const data = await listFavorites(ctx);
            return { data, markdown: favoritesMarkdown(data) };
        },
    }),
    accountOperation({
        name: "orders_list",
        description: "The signed-in account's orders: active ones and the archive (number, date, status).",
        input: z.object({
            archive: z.boolean().optional().describe("Include archived orders (default true)"),
            hide_cancelled: z.boolean().optional().describe("Leave cancelled orders out of the archive"),
            limit: z.number().int().min(1).max(100).optional().describe("Archive page size (max 100)"),
        }),
        kind: "read",
        run: async (ctx, i) => {
            const data = await listOrders(ctx, { archive: i.archive, hideCancelled: i.hide_cancelled, limit: i.limit });
            return { data, markdown: ordersMarkdown(data) };
        },
    }),
    accountOperation({
        name: "order_show",
        description: "One order of the signed-in account: status of each part, dates, total, and the full raw answer.",
        input: z.object({ order: z.string().min(6).describe("Order number, e.g. 1058423434 or '1058 423 434'") }),
        kind: "read",
        run: async (ctx, i) => {
            const data = await showOrder(ctx, i.order);
            return { data, markdown: orderMarkdown(data.order) };
        },
    }),
    accountOperation({
        name: "watchdog_list",
        description:
            "The account's price and stock watchdogs (Hlídací pes): product, current price, alert condition, id.",
        input: z.object({ limit: z.number().int().min(1).max(100).optional().describe("How many (max 100)") }),
        kind: "read",
        run: async (ctx, i) => {
            const data = await listWatchdogs(ctx, { limit: i.limit });
            return { data, markdown: watchdogsMarkdown(data, ctx.api.storefront.currency) };
        },
    }),
    accountOperation({
        name: "watchdog_add",
        description:
            "Watch a product: Alza emails the account when the price drops below max_price and/or when it is back in stock. Without max_price it watches the stock.",
        input: z.object({
            product,
            max_price: z.number().positive().optional().describe("Alert when the price drops below this"),
            stock: z.boolean().optional().describe("Alert when it is back in stock"),
        }),
        kind: "write",
        run: async (ctx, i) => {
            const data = await addWatchdog(ctx, { product: i.product, maxPrice: i.max_price, stock: i.stock });
            const id = data.created.id ? ` ${data.created.id}` : "";
            return { data, markdown: `Watchdog${id} set for product ${data.productId}.` };
        },
    }),
    accountOperation({
        name: "watchdog_remove",
        description: "Remove a watchdog, by its id from watchdog_list or by the product it watches.",
        input: z.object({ watchdog: z.string().min(1).describe("Watchdog id (UUID) or the watched product") }),
        kind: "write",
        run: async (ctx, i) => {
            const data = await removeWatchdog(ctx, { ref: i.watchdog });
            return { data, markdown: `Watchdog ${data.removed} removed.` };
        },
    }),
];

export function findAccountOperation(name: string): AccountOperation {
    const op = ACCOUNT_OPERATIONS.find((candidate) => candidate.name === name);
    if (!op) {
        throw new Error(`Unknown Alza account operation: ${name}`);
    }

    return op;
}
