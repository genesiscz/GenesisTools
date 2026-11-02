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
import {
    addressSearch,
    afterOrderPayments,
    chatNavigation,
    checkoutPreview,
    claimDetail,
    complaintClaims,
    contacts,
    type DeliveryOptions,
    deliveryOptions,
    gdprInfo,
    mobileRead,
    mutateList,
    orderDocument,
    orderSearch,
    profile,
    RAW_READ_NAMES,
    RAW_READS,
    rawMarkdown,
    selectPickupPoint,
    subscriptionOverview,
} from "./account-extras";
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
    /** A write that deletes or replaces something (a basket line, a watchdog, a list entry, a local file). */
    destructive?: boolean;
    /** Left out of the MCP tool list unless the server is started with the raw tools (`mobile_read`). */
    hidden?: boolean;
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
    destructive?: boolean;
    hidden?: boolean;
    run(ctx: AccountContext, input: z.infer<S>): Promise<OperationResult>;
}): AccountOperation {
    const call = (ctx: AccountContext, input: z.infer<S>) => def.run(ctx, input).catch(signInErrors);
    return {
        ...def,
        run: (ctx, args) => {
            const input = def.input.parse(args);
            // A diagnostic changes nothing, not even the visitor. Any other call may create the basket and take its cookie.
            if (def.kind === "diagnostic") {
                return call(ctx, input);
            }

            return ctx.session.withVisitor(() => call(ctx, input), { signedIn: Boolean(ctx.auth.readTokens()) });
        },
    };
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
        return `The list is empty${f.signedIn ? "" : " (anonymous visitor, not signed in)"}.`;
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

export function deliveryMarkdown(o: DeliveryOptions, payments = true): string {
    const lines: string[] = [];
    for (const group of o.groups) {
        lines.push(`**Delivery group ${group.id}** (${group.deliveries.length} options)`);
        for (const d of group.deliveries) {
            lines.push(`- ${d.name} \`${d.id}\` ${d.price ?? ""}${d.type ? ` · ${d.type}` : ""}`);
        }
    }

    if (payments) {
        lines.push(
            "",
            "**Payments**",
            ...o.payments.map((p) => `- ${p.name} \`${p.id}\`${p.group ? ` · ${p.group}` : ""}`)
        );
    }

    if (o.warnings.length > 0) {
        lines.push("", ...o.warnings.map((w) => `Note: ${w.length > 200 ? `${w.slice(0, 200)}…` : w}`));
    }

    return lines.join("\n");
}

const LIST_NAMES = ["favorites", "later"] as const;
const CLAIM_SCOPES = ["active", "archive"] as const;
const deliveryOptionId = z
    .number()
    .int()
    .positive()
    .optional()
    .describe("A delivery option id from delivery_options, to anchor the listing on that delivery");

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
        destructive: true,
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
        destructive: true,
        run: async (ctx, i) => {
            const data = await removeWatchdog(ctx, { ref: i.watchdog });
            return { data, markdown: `Watchdog ${data.removed} removed.` };
        },
    }),
    accountOperation({
        name: "profile",
        description:
            "The signed-in account's profile (getUserData): user id, name, email, phone, address book and sections. --json has the full answer.",
        input: z.object({}),
        kind: "read",
        run: async (ctx) => {
            const data = await profile(ctx);
            const lines = Object.entries(data.summary).map(([key, value]) => `- ${key}: ${value}`);
            return {
                data,
                markdown: ["**Profile**", ...lines, "", "The full answer is in `--json` (`raw`)."].join("\n"),
            };
        },
    }),
    accountOperation({
        name: "contacts",
        description: "Alza's contact channels (contact form, phone line, billing address). Works without a sign-in.",
        input: z.object({}),
        kind: "read",
        run: async (ctx) => {
            const data = await contacts(ctx);
            return {
                data,
                markdown: data
                    .map((c) => `- **${c.title}**${c.text ? `: ${c.text}` : ""}${c.url ? ` (${c.url})` : ""}`)
                    .join("\n"),
            };
        },
    }),
    accountOperation({
        name: "gdpr_info",
        description:
            "The account's GDPR section and data-export dialog (where an export would be sent). Reads only; it does not request the export.",
        input: z.object({}),
        kind: "read",
        run: async (ctx) => {
            const data = await gdprInfo(ctx);
            return {
                data,
                markdown: `${rawMarkdown("GDPR section", data.personalDetails)}\n\n${rawMarkdown("Export dialog", data.gdprDialog)}`,
            };
        },
    }),
    accountOperation({
        name: "subscription_overview",
        description:
            "The account's AlzaPlus+ / subscription section, as Alza's own form (its options and links); --json has it whole.",
        input: z.object({}),
        kind: "read",
        run: async (ctx) => {
            const data = await subscriptionOverview(ctx);
            return { data, markdown: rawMarkdown("Subscription", data) };
        },
    }),
    accountOperation({
        name: "delivery_options",
        description:
            "Delivery options (AlzaBox, shops, courier) and payment methods for the current basket, signed in or as the visitor. Needs a basket with products.",
        input: z.object({ selected_delivery_option_id: deliveryOptionId }),
        kind: "read",
        run: async (ctx, i) => {
            const data = await deliveryOptions(ctx, { deliveryOptionId: i.selected_delivery_option_id });
            return { data, markdown: deliveryMarkdown(data) };
        },
    }),
    accountOperation({
        name: "payment_methods",
        description:
            "The payment methods for the current basket (the payment half of delivery_options). Needs a basket with products.",
        input: z.object({ selected_delivery_option_id: deliveryOptionId }),
        kind: "read",
        run: async (ctx, i) => {
            const data = (await deliveryOptions(ctx, { deliveryOptionId: i.selected_delivery_option_id })).payments;
            return {
                data,
                markdown: [
                    "**Payments**",
                    ...data.map((p) => `- ${p.name} \`${p.id}\`${p.group ? ` · ${p.group}` : ""}`),
                ].join("\n"),
            };
        },
    }),
    accountOperation({
        name: "select_pickup_point",
        description:
            "Despite the name (kept from the reference), this does not pick an AlzaBox: for one delivery option it lists the payments that fit and the resulting prices (getDeliveryAssociations). Changes nothing seen in the basket and orders nothing.",
        input: z.object({
            delivery_id: z.number().int().positive().describe("Delivery option id from delivery_options"),
            delivery_group_id: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Its group id; found from delivery_options when omitted"),
            parcel_shop_id: z.number().int().min(0).optional().describe("A pickup place id, when the delivery has one"),
        }),
        kind: "write",
        run: async (ctx, i) => {
            const data = await selectPickupPoint(ctx, {
                deliveryId: i.delivery_id,
                deliveryGroupId: i.delivery_group_id,
                parcelShopId: i.parcel_shop_id,
            });
            const lines = data.payments.map(
                (p) => `- ${p.name ?? p.id} \`${p.id}\`: delivery ${p.price ?? "?"}, payment ${p.paymentPrice ?? "?"}`
            );
            return { data, markdown: [`**Payments for delivery ${data.deliveryId}**`, ...lines].join("\n") };
        },
    }),
    accountOperation({
        name: "checkout_preview",
        description:
            "Preview the checkout of the current basket: lines, total, delivery and payment options. Runs Alza's first checkout step (sendOrder1), so it is not read-only, but it never places an order: this tool has no order step.",
        input: z.object({ selected_delivery_option_id: deliveryOptionId }),
        kind: "write",
        run: async (ctx, i) => {
            const data = await checkoutPreview(ctx, { deliveryOptionId: i.selected_delivery_option_id });
            return {
                data,
                markdown: `${cartMarkdown(data.cart)}\n\n${deliveryMarkdown(data.options)}\n\nNothing was ordered.`,
            };
        },
    }),
    accountOperation({
        name: "address_search",
        description:
            "Look up postal codes and places in Alza's address database (e.g. '110 00' or 'Brno'). No sign-in needed.",
        input: z.object({ query: z.string().min(1).max(50).describe("A postal code or a place") }),
        kind: "read",
        run: async (ctx, i) => {
            const data = await addressSearch(ctx, i.query);
            return { data, markdown: data.length ? data.map((a) => `- ${a.zip} ${a.city}`).join("\n") : "No match." };
        },
    }),
    accountOperation({
        name: "chat_navigation",
        description:
            "The live chatbot's navigation for this visitor: its initialize, restart, metadata and rating actions. Reads only; sends no message.",
        input: z.object({}),
        kind: "read",
        run: async (ctx) => {
            const data = await chatNavigation(ctx);
            return { data, markdown: data.map((a) => `- ${a.name}${a.href ? `: ${a.href}` : ""}`).join("\n") };
        },
    }),
    accountOperation({
        name: "order_search",
        description:
            "Search the signed-in account's orders by order number or product name; results carry invoice links for order_document.",
        input: z.object({
            query: z.string().min(1).max(64).describe("Order number (e.g. '1058 423 434') or product words"),
        }),
        kind: "read",
        run: async (ctx, i) => {
            const data = await orderSearch(ctx, i.query);
            const docs = data.orders.flatMap((o) =>
                (o.documents ?? []).map((d) => `  - ${d.name ?? "document"}: ${d.href}`)
            );
            return {
                data,
                markdown: [
                    ordersMarkdown({ orders: data.orders, hasMoreArchive: false }),
                    ...(docs.length ? ["", "Documents:", ...docs] : []),
                ].join("\n"),
            };
        },
    }),
    accountOperation({
        name: "order_document",
        description:
            "Download an order invoice or document to a file. The link must be an https Alza document URL as order_search returns it: a pdf.alza.cz invoice, or a route of one of the account's orders. Redirects are not followed; at most 8 MiB.",
        input: z.object({
            url: z.string().min(10).max(800).describe("The document link from order_search or order_show"),
            output: z.string().min(1).describe("File path to write"),
            overwrite: z.boolean().optional().describe("Replace an existing file"),
        }),
        // Writes a local file, so MCP clients must not treat it as read-only; with overwrite it replaces one.
        kind: "write",
        destructive: true,
        run: async (ctx, i) => {
            const data = await orderDocument(ctx, { href: i.url, output: i.output, overwrite: i.overwrite });
            return {
                data,
                markdown: `Saved ${data.bytes} bytes${data.contentType ? ` (${data.contentType})` : ""} to ${data.path}.`,
            };
        },
    }),
    accountOperation({
        name: "after_order_payments",
        description: "The payment options still open for an unpaid order part (read only; this tool cannot pay).",
        input: z.object({
            order_id: z.string().min(1).max(16).describe("Order number"),
            part_id: z.string().min(1).max(16).describe("Order part number (see order_show)"),
        }),
        kind: "read",
        run: async (ctx, i) => {
            const data = await afterOrderPayments(ctx, { orderId: i.order_id, partId: i.part_id });
            return { data, markdown: rawMarkdown(`After-order payments for ${i.order_id}/${i.part_id}`, data) };
        },
    }),
    accountOperation({
        name: "complaint_claims",
        description:
            "The account's warranty claims, active (default) or archived; each carries a detailAction link for claim_detail.",
        input: z.object({ scope: z.enum(CLAIM_SCOPES).optional().describe("active (default) or archive") }),
        kind: "read",
        run: async (ctx, i) => {
            const data = await complaintClaims(ctx, i.scope ?? "active");
            return { data, markdown: rawMarkdown(`Warranty claims (${i.scope ?? "active"})`, data) };
        },
    }),
    accountOperation({
        name: "claim_detail",
        description:
            "One warranty claim, by the detailAction href from complaint_claims. Only https links on the account's warranty-claims routes are followed.",
        input: z.object({ href: z.string().min(10).max(800).describe("The claim's detailAction href") }),
        kind: "read",
        run: async (ctx, i) => {
            const data = await claimDetail(ctx, i.href);
            return { data, markdown: rawMarkdown("Warranty claim", data) };
        },
    }),
    accountOperation({
        name: "mutate_list",
        description:
            "Add a product to, or remove it from, the favourites (Oblíbené) or the buy-later list. Works signed in and for the visitor.",
        input: z.object({
            action: z.enum(["add", "remove"]).describe("add or remove"),
            product,
            list: z.enum(LIST_NAMES).optional().describe("favorites (default) or later"),
        }),
        kind: "write",
        destructive: true,
        run: async (ctx, i) => {
            const data = await mutateList(ctx, { action: i.action, product: i.product, list: i.list ?? "favorites" });
            return {
                data,
                markdown: `${i.action === "add" ? "Added" : "Removed"} product ${data.productId}.\n\n${favoritesMarkdown(data.list)}`,
            };
        },
    }),
    accountOperation({
        name: "mobile_read",
        description: `Raw read-only escape hatch: one fixed GET route of the Alza app, answer returned whole. Operations: ${Object.entries(
            RAW_READS
        )
            .map(([name, op]) => `${name} (${op.description})`)
            .join("; ")}. Never takes a URL, never writes.`,
        input: z.object({
            operation: z.enum(RAW_READ_NAMES).describe("Which fixed read to run"),
            args: z.record(z.string(), z.string()).optional().describe("Its arguments, e.g. {product_id: '9383715'}"),
        }),
        kind: "read",
        hidden: true,
        run: async (ctx, i) => {
            const data = await mobileRead(ctx, { operation: i.operation, args: i.args });
            return { data, markdown: rawMarkdown(i.operation, data) };
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
