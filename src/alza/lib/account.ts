import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ImpersonatedHttpClient } from "@genesiscz/utils/http/impersonate/client";
import { libcurlImpersonateInstalled } from "@genesiscz/utils/http/impersonate/library";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";
import {
    basketAddSchema,
    commodityListsSchema,
    type GridLine,
    type GridOrder,
    gridOrderSchema,
    type Hyper,
    type OrderRaw,
    orderSchema,
    ordersPageSchema,
    orderUpdateSchema,
    userDataSchema,
    type WatchdogDialogRaw,
    type WatchdogListRaw,
    watchdogCreatedSchema,
    watchdogDialogSchema,
    watchdogListSchema,
} from "./account-schemas";
import { AlzaApi, AlzaApiError, WEBAPI } from "./api";
import { AlzaAuth, isExpiring, NotSignedInError, SIGN_IN_HINT } from "./auth";
import { getProduct, parsePrice, productIdFromRef, resolveProductId } from "./catalog";
import { VisitorSession } from "./state";
import { STOREFRONTS, type StorefrontId } from "./storefront";

/**
 * The signed-in account and the visitor basket. Routes: lukabudik/alza-mcp-community docs/mobile-endpoint-coverage.md
 * (MIT) rows B1-B3 (basket), B9-B9b (watchdog), B10 (lists), OR1/OR7 (orders); the basket remove route was read from
 * the web basket's own `updateAction` form on 2026-11-01. Watchdog parsing adapted from lukabudik/alza-mcp-community
 * (MIT) — src/domain/watchdog.ts.
 */

export interface AccountContext {
    api: AlzaApi;
    auth: AlzaAuth;
    session: VisitorSession;
}

/** One http client shared by the API and the token requests, the persisted visitor, and the stored tokens. */
export function openAccountContext(opts: {
    storefront?: StorefrontId;
    http?: ImpersonatedHttpClient;
}): AccountContext & {
    close(opts?: { save?: boolean }): Promise<void>;
} {
    const http = opts.http ?? new ImpersonatedHttpClient({ label: "alza" });
    const storefront = opts.storefront ?? "cz";
    const session = VisitorSession.forStorefront(storefront);
    const auth = new AlzaAuth({ http, storefront: STOREFRONTS[storefront], visitorId: session.visitorId });
    const api = new AlzaApi({
        storefront,
        http,
        visitorId: session.visitorId,
        cookies: session,
        accessToken: () => auth.accessToken(),
    });
    return {
        api,
        auth,
        session,
        close: async ({ save = true } = {}) => {
            if (save) {
                session.save();
            }

            if (!opts.http) {
                await http.close();
            }
        },
    };
}

export function requireSignedIn(ctx: AccountContext): void {
    if (!ctx.auth.readTokens()) {
        throw new NotSignedInError();
    }
}

/** The legacy restservice answers a stale token with HTTP 200 and the anonymous visitor (user_id -1) instead of 401. */
export function assertNotAnonymous(ctx: AccountContext, answer: { user_id?: number | null }, what: string): void {
    if (ctx.auth.readTokens() && answer.user_id === -1) {
        throw new NotSignedInError(
            `Alza answered ${what} as an anonymous visitor although a sign-in is stored; the token was not accepted. ${SIGN_IN_HINT}`
        );
    }
}

export function assertNoError(answer: { err?: number | null; msg?: string | null }, what: string): void {
    if (answer.err && answer.err !== 0) {
        throw new AlzaApiError(`Alza refused ${what}: ${answer.msg ?? `error ${answer.err}`}`, 200);
    }
}

const userIds = new WeakMap<AccountContext, number>();

/** The numeric Alza user id the /api/users/{id} routes need: from the token file, else one getUserData read. */
export async function userId(ctx: AccountContext): Promise<number> {
    requireSignedIn(ctx);
    const stored = ctx.auth.readTokens()?.user_id ?? userIds.get(ctx);
    if (stored) {
        return stored;
    }

    const data = await ctx.api.json(userDataSchema, "/services/restservice.svc/v2/getUserData", { withToken: true });
    assertNotAnonymous(ctx, data, "the account read");
    if (!data.user_id || data.user_id < 1) {
        throw new NotSignedInError(`Alza did not name the signed-in account. ${SIGN_IN_HINT}`);
    }

    userIds.set(ctx, data.user_id);
    await ctx.auth.rememberUserId(data.user_id);
    return data.user_id;
}

// ── status ───────────────────────────────────────────────────────────────────

export interface AccountStatus {
    signedIn: boolean;
    expiresAt?: string;
    expired?: boolean;
    hasRefreshToken?: boolean;
    userId?: number;
    /** What the one read-only check against Alza said; absent when it was skipped. */
    check?: { ok: boolean; userName?: string; detail: string };
    visitorId: string;
    basketCookie: boolean;
}

/**
 * A diagnostic: reads the token file and, when the access token is still valid, sends it once to getUserData as is.
 * It never refreshes, never writes a file, and neither sends nor takes the visitor cookies. The first request of a
 * fresh install downloads the HTTP library, so the check is skipped until another command has installed it.
 */
export async function accountStatus(
    ctx: AccountContext,
    opts: { transportInstalled?: () => boolean } = {}
): Promise<AccountStatus> {
    const stored = ctx.auth.readTokens();
    const base = { visitorId: ctx.session.visitorId, basketCookie: Boolean(ctx.session.header()?.includes("IDOX=")) };
    if (!stored) {
        return { signedIn: false, ...base };
    }

    const expired = isExpiring(stored);
    const status: AccountStatus = {
        signedIn: true,
        expiresAt: stored.expires_at,
        expired,
        hasRefreshToken: Boolean(stored.refresh_token),
        userId: stored.user_id,
        ...base,
    };
    if (expired) {
        status.check = {
            ok: false,
            detail: stored.refresh_token
                ? "The access token expired; the next account command renews it with the refresh token."
                : `The access token expired and there is no refresh token. ${SIGN_IN_HINT}`,
        };
        return status;
    }

    if (!(opts.transportInstalled ?? libcurlImpersonateInstalled)()) {
        status.check = {
            ok: false,
            detail: `Not checked: the Chrome-fingerprint HTTP library is not installed yet, and a status check installs nothing. Any catalog command installs it, for example ${toolCommand("alza search ssd")}.`,
        };
        return status;
    }

    try {
        const data = await ctx.api.json(userDataSchema, "/services/restservice.svc/v2/getUserData", {
            token: stored.access_token,
            noCookies: true,
        });
        const accepted = typeof data.user_id === "number" && data.user_id > 0;
        status.check = {
            ok: accepted,
            userName: accepted ? (data.user_name ?? undefined) : undefined,
            detail: accepted
                ? `Alza accepted the token (user ${data.user_id}).`
                : `Alza answered as an anonymous visitor: the token was not accepted. ${SIGN_IN_HINT}`,
        };
        status.userId ??= accepted ? (data.user_id ?? undefined) : undefined;
    } catch (error) {
        logger.debug({ error }, "alza status check failed");
        status.check = { ok: false, detail: `The check against Alza failed: ${errorText(error)}` };
    }

    return status;
}

/** After `auth.completeLogin`: one account read to learn the numeric user id the order and watchdog routes need. */
export async function afterSignIn(ctx: AccountContext): Promise<{ userId?: number; userName?: string }> {
    const data = await ctx.api.json(userDataSchema, "/services/restservice.svc/v2/getUserData", { withToken: true });
    if (!data.user_id || data.user_id < 1) {
        logger.warn("alza getUserData did not name the account right after sign-in");
        return {};
    }

    await ctx.auth.rememberUserId(data.user_id);
    return { userId: data.user_id, userName: data.user_name ?? undefined };
}

// ── basket ───────────────────────────────────────────────────────────────────

export interface CartLine {
    orderItemId: number;
    productId?: number;
    code?: string;
    name: string;
    quantity: number;
    unitPrice?: number;
    lineTotal?: number;
    priceText?: string;
    availability?: string;
}

export interface CartView {
    signedIn: boolean;
    items: CartLine[];
    itemCount: number;
    total?: number;
    totalText?: string;
    currency: string;
    message?: string;
}

function toCartLine(line: GridLine): CartLine {
    const quantity = line.count ?? 1;
    const unitPrice = parsePrice(line.pricePerItemVat) ?? line.priceNoCurrency ?? undefined;
    return {
        orderItemId: line.orderItemId,
        productId: line.commodityId ?? undefined,
        code: line.code ?? undefined,
        name: line.name ?? line.code ?? `item ${line.orderItemId}`,
        quantity,
        unitPrice,
        lineTotal: parsePrice(line.priceVat) ?? (unitPrice === undefined ? undefined : unitPrice * quantity),
        priceText: line.priceVat ?? undefined,
        availability: line.availability?.[0]?.AvailAbility ?? undefined,
    };
}

/** Product lines of gridOrder1; selected services (warranty, gift wrap) hang under a parent line and are skipped. */
export function parseCart(grid: GridOrder, opts: { signedIn: boolean; currency: string }): CartView {
    const items = (grid.data ?? []).filter((line) => !line.parentId).map(toCartLine);
    return {
        signedIn: opts.signedIn,
        items,
        itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
        total: grid.pricePayAmt ?? parsePrice(grid.price_pay),
        totalText: grid.price_pay ?? undefined,
        currency: opts.currency,
        message: items.length === 0 ? (grid.msg ?? undefined) : undefined,
    };
}

export async function showCart(ctx: AccountContext): Promise<CartView> {
    const grid = await ctx.api.json(gridOrderSchema, "/services/restservice.svc/v10/gridOrder1", { withToken: true });
    assertNotAnonymous(ctx, grid, "the basket read");
    assertNoError(grid, "the basket read");
    return parseCart(grid, { signedIn: Boolean(ctx.auth.readTokens()), currency: ctx.api.storefront.currency });
}

/** A product code as Alza's basket/add wants it: taken as is, or read from the product when given an id or URL. */
async function productCode(ctx: AccountContext, ref: string): Promise<string> {
    if (productIdFromRef(ref) === undefined) {
        return ref.trim();
    }

    return (await getProduct(ctx.api, ref)).code;
}

export async function addToCart(
    ctx: AccountContext,
    opts: { product: string; quantity: number }
): Promise<{ added: { code: string; name?: string; quantity: number }; cart: CartView }> {
    const code = await productCode(ctx, opts.product);
    const answer = await ctx.api.json(basketAddSchema, "/services/restservice.svc/v2/basket/add", {
        method: "POST",
        body: { code, amount: opts.quantity },
        withToken: true,
    });
    if (ctx.auth.readTokens() && answer.user_id === -1) {
        throw new NotSignedInError(
            `Alza answered the add as an anonymous visitor although a sign-in is stored, so the product may be in the visitor basket instead of the account's. Check \`cart show\`. ${SIGN_IN_HINT}`
        );
    }

    assertNoError(answer, `adding ${code} to the basket`);
    logger.debug({ code, quantity: opts.quantity }, "alza basket add");
    return {
        added: { code: answer.data?.code ?? code, name: answer.data?.name ?? undefined, quantity: opts.quantity },
        cart: await showCart(ctx),
    };
}

/** The basket line of a product given by code, numeric id or URL. */
export function findCartLine(cart: CartView, ref: string): CartLine | undefined {
    const id = productIdFromRef(ref);
    const code = ref.trim().toLowerCase();
    return cart.items.find((item) => (id !== undefined ? item.productId === id : item.code?.toLowerCase() === code));
}

export async function removeFromCart(
    ctx: AccountContext,
    opts: { product: string }
): Promise<{ removed: CartLine; cart: CartView }> {
    const before = await showCart(ctx);
    const line = findCartLine(before, opts.product);
    if (!line) {
        throw new AlzaApiError(`${opts.product} is not in the basket.`, 404);
    }

    const answer = await ctx.api.json(
        orderUpdateSchema,
        `/Services/EShopService.svc/OrderUpdate?country=${ctx.api.storefront.country}`,
        {
            method: "POST",
            body: { id: line.orderItemId, count: 0, accessories: [], source: 2 },
            withToken: true,
        }
    );
    if (answer.d.ErrorLevel && answer.d.ErrorLevel !== 0) {
        throw new AlzaApiError(
            `Alza refused to remove ${line.code ?? line.name}: ${answer.d.Message ?? `error level ${answer.d.ErrorLevel}`}`,
            200
        );
    }

    logger.debug({ code: line.code, orderItemId: line.orderItemId }, "alza basket remove");
    return { removed: line, cart: await showCart(ctx) };
}

// ── favourites ───────────────────────────────────────────────────────────────

export interface FavoriteItem {
    id: number;
    code?: string;
    name?: string;
    price?: number;
    originalPrice?: number;
    availability?: string;
    url?: string;
}

export interface FavoritesView {
    signedIn: boolean;
    lists: Array<{ id: number; name: string; count: number; items: FavoriteItem[] }>;
    currency: string;
}

/** Shopping list types the app uses: 1 = Oblíbené (favourites), 14 = Uložit na později (buy later). */
export const LIST_TYPES = { favorites: 1, later: 14 } as const;
export type ListName = keyof typeof LIST_TYPES;

/** The "Oblíbené" list (type 1). Live 2026-11-01: answered for an anonymous visitor too, with its items. */
export async function listFavorites(ctx: AccountContext): Promise<FavoritesView> {
    return listCommodityList(ctx, "favorites");
}

/** One shopping list by type, with its items. Keyed like the basket: the account, or the visitor cookie. */
export async function listCommodityList(ctx: AccountContext, list: ListName): Promise<FavoritesView> {
    const answer = await ctx.api.json(
        commodityListsSchema,
        `/services/restservice.svc/v1/getCommodityLists?type=${LIST_TYPES[list]}`,
        { withToken: true }
    );
    assertNotAnonymous(ctx, answer, "the list read");
    // A visitor who never saved a favourite has no list yet: Alza answers err 1 "Seznam nenalezen" with no data.
    const noList = answer.err === 1 && (answer.data ?? []).length === 0;
    if (!noList) {
        assertNoError(answer, "the list read");
    }

    return {
        signedIn: Boolean(ctx.auth.readTokens()),
        currency: ctx.api.storefront.currency,
        lists: (answer.data ?? []).map((list) => ({
            id: list.id,
            name: list.name ?? `list ${list.id}`,
            count: list.itemCount ?? list.items?.length ?? 0,
            items: (list.items ?? []).map((item) => ({
                id: item.id,
                code: item.code ?? undefined,
                name: item.name ?? undefined,
                price: item.priceNoCurrency ?? parsePrice(item.price),
                originalPrice: parsePrice(item.cprice),
                availability: item.avail ?? undefined,
                url: item.navigationUrl ?? undefined,
            })),
        })),
    };
}

// ── orders ───────────────────────────────────────────────────────────────────

export interface OrderSummary {
    id: string;
    number?: string;
    name?: string;
    created?: string;
    status?: string;
    total?: string;
    parts: Array<{ number?: string; name?: string; status?: string }>;
    /** Invoices and other documents (order search results carry them); `orders document <href>` downloads one. */
    documents?: Array<{ name?: string; href: string }>;
    list?: OrderListName;
}

export type OrderListName = "active" | "archive" | "search";

function textOf(value: string | number | null | undefined): string | undefined {
    if (value === null || value === undefined || value === "") {
        return undefined;
    }

    return String(value);
}

/** One order of the lists or the detail. The list item shape was never seen live, so every field is optional. */
export function toOrderSummary(raw: OrderRaw): OrderSummary | undefined {
    const id = textOf(raw.orderId) ?? raw.orderNumber?.replace(/\s+/g, "") ?? orderIdFromHref(hrefOf(raw.self));
    if (!id) {
        return undefined;
    }

    const parts = (raw.parts ?? []).map((part) => ({
        number: part.partNumber ?? undefined,
        name: part.partName ?? undefined,
        status: part.status ?? undefined,
    }));
    return {
        id,
        number: raw.orderNumber ?? undefined,
        name: raw.orderName ?? raw.orderTypeName ?? undefined,
        created: raw.created ?? raw.parts?.[0]?.created ?? undefined,
        status: raw.status ?? parts.find((part) => part.status)?.status,
        total: textOf(raw.totalPrice) ?? textOf(raw.price),
        parts,
        documents: raw.documents?.length
            ? raw.documents.flatMap((doc) => {
                  const href = hrefOf(doc.self);
                  return href ? [{ name: doc.name ?? undefined, href }] : [];
              })
            : undefined,
    };
}

function orderIdFromHref(href: string | undefined): string | undefined {
    return href ? /\/orders\/(\d{6,})/.exec(href)?.[1] : undefined;
}

export function parseOrders(raw: unknown, list: OrderListName): { orders: OrderSummary[]; hasMore: boolean } {
    const page = ordersPageSchema.parse(raw);
    const orders = [...(page.value ?? []), ...(page.orders ?? [])].flatMap((item) => {
        const parsed = orderSchema.safeParse(item);
        if (!parsed.success) {
            logger.warn(
                { list, issues: parsed.error.issues.slice(0, 3) },
                "alza order list item of an unknown shape skipped"
            );
            return [];
        }

        const summary = toOrderSummary(parsed.data);
        if (!summary) {
            logger.debug({ list }, "alza order list item without an id skipped");
            return [];
        }

        return [{ ...summary, list }];
    });
    return { orders, hasMore: Boolean(page.paging?.next) };
}

export async function listOrders(
    ctx: AccountContext,
    opts: { archive?: boolean; hideCancelled?: boolean; limit?: number }
): Promise<{ orders: OrderSummary[]; hasMoreArchive: boolean }> {
    const uid = await userId(ctx);
    const active = await ctx.api.json(z.unknown(), `/api/users/${uid}/v1/orders/active?productFilterType=0`, {
        withToken: true,
    });
    const result = parseOrders(active, "active");
    let hasMoreArchive = false;
    if (opts.archive !== false) {
        const query = new URLSearchParams({
            hideCancelledOrders: opts.hideCancelled ? "true" : "false",
            productFilterType: "0",
        });
        if (opts.limit !== undefined) {
            query.set("limit", String(opts.limit));
        }

        const archive = parseOrders(
            await ctx.api.json(z.unknown(), `/api/users/${uid}/v1/orders/archive?${query}`, { withToken: true }),
            "archive"
        );
        result.orders.push(...archive.orders.filter((order) => !result.orders.some((a) => a.id === order.id)));
        hasMoreArchive = archive.hasMore;
    }

    return { orders: result.orders, hasMoreArchive };
}

export async function showOrder(ctx: AccountContext, orderRef: string): Promise<{ order: OrderSummary; raw: unknown }> {
    const orderId = orderRef.replace(/\s+/g, "");
    if (!/^\d{6,16}$/.test(orderId)) {
        throw new AlzaApiError(`"${orderRef}" is not an order number (digits, e.g. 1058423434).`, 400);
    }

    const uid = await userId(ctx);
    const raw = await ctx.api.json(
        z.unknown(),
        `/api/users/${uid}/v1/orders/${orderId}?country=${ctx.api.storefront.country}`,
        { withToken: true }
    );
    const parsed = orderSchema.safeParse(raw);
    const order = (parsed.success ? toOrderSummary(parsed.data) : undefined) ?? { id: orderId, parts: [] };
    return { order, raw };
}

// ── watchdogs ────────────────────────────────────────────────────────────────

const WATCHDOG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WATCHDOG_ID_IN_PATH =
    /\/(?:watchdog\/v1|watchDogs)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?]|$)/i;

export interface Watchdog {
    id?: string;
    productId?: number;
    name?: string;
    url?: string;
    currentPrice?: number;
    availability?: string;
    trackingStock?: boolean;
    /** Alert when the price drops below this; absent = not watching the price. */
    maxPrice?: number;
}

function hrefOf(hyper: Hyper): string | undefined {
    return hyper?.href ?? hyper?.form?.href ?? undefined;
}

function fieldOf(hyper: Hyper, name: string) {
    return [...(hyper?.value ?? []), ...(hyper?.form?.value ?? [])].find((field) => field.name === name);
}

export function watchdogIdFromHref(href: string | undefined): string | undefined {
    return href ? WATCHDOG_ID_IN_PATH.exec(href)?.[1]?.toLowerCase() : undefined;
}

export function parseWatchdogList(raw: WatchdogListRaw): { items: Watchdog[]; hasMore: boolean; empty?: string } {
    const items = (raw.value ?? []).map((item): Watchdog => {
        const detail = hrefOf(item.commodityDetail);
        const url = item.commodityUrl ?? undefined;
        const idMatch = (detail && /\/product\/(\d+)/.exec(detail)) || (url && /-d(\d+)\.htm/.exec(url));
        const tracking = fieldOf(item.updateForm, "isTrackingStock")?.value;
        const price = fieldOf(item.updateForm, "price")?.value;
        return {
            id: watchdogIdFromHref(hrefOf(item.updateForm)) ?? watchdogIdFromHref(hrefOf(item.deleteAction)),
            productId: idMatch ? Number(idMatch[1]) : undefined,
            name: item.commodityName ?? undefined,
            url,
            currentPrice: item.priceInfoV2?.priceNoCurrency ?? undefined,
            availability: item.availabilityText ?? undefined,
            trackingStock: typeof tracking === "boolean" ? tracking : undefined,
            maxPrice: typeof price === "number" ? price : undefined,
        };
    });
    return { items, hasMore: Boolean(raw.paging?.next), empty: raw.emptyInfo?.message ?? undefined };
}

/** Does a watchdog exist for the product, and what does the create form expect. The email is never surfaced. */
export function parseWatchdogDialog(raw: WatchdogDialogRaw): {
    existingId?: string;
    exists: boolean;
    email?: string;
    priceMax?: number;
} {
    const deleteHref = hrefOf(raw.deleteAction);
    const email = fieldOf(raw.form, "email")?.value;
    return {
        exists: Boolean(deleteHref),
        existingId: watchdogIdFromHref(deleteHref),
        email: typeof email === "string" && email ? email : undefined,
        priceMax: fieldOf(raw.form, "price")?.max ?? undefined,
    };
}

export async function listWatchdogs(
    ctx: AccountContext,
    opts: { limit?: number } = {}
): Promise<{ items: Watchdog[]; hasMore: boolean; empty?: string }> {
    const uid = await userId(ctx);
    const query = new URLSearchParams({ country: ctx.api.storefront.country });
    if (opts.limit !== undefined) {
        query.set("limit", String(opts.limit));
    }

    return parseWatchdogList(
        await ctx.api.json(watchdogListSchema, `/api/users/${uid}/v1/watchDogs/commodities?${query}`, {
            withToken: true,
        })
    );
}

async function watchdogDialog(ctx: AccountContext, uid: number, productId: number) {
    return parseWatchdogDialog(
        await ctx.api.json(
            watchdogDialogSchema,
            `/api/v1/users/${uid}/products/${productId}/watchdogDialog?country=${ctx.api.storefront.country}`,
            { withToken: true }
        )
    );
}

export async function addWatchdog(
    ctx: AccountContext,
    opts: { product: string; maxPrice?: number; stock?: boolean }
): Promise<{ created: Watchdog; productId: number }> {
    const uid = await userId(ctx);
    const productId = await resolveProductId(ctx.api, opts.product);
    const trackingStock = opts.stock ?? opts.maxPrice === undefined;
    if (!trackingStock && opts.maxPrice === undefined) {
        throw new AlzaApiError("Nothing to watch: pass --price <max>, --stock, or both.", 400);
    }

    const dialog = await watchdogDialog(ctx, uid, productId);
    if (dialog.exists) {
        throw new AlzaApiError(
            `A watchdog already exists for product ${productId}${dialog.existingId ? ` (${dialog.existingId})` : ""}. Remove it first.`,
            409
        );
    }

    if (!dialog.email) {
        throw new NotSignedInError(`Alza's watchdog form did not pre-fill the account email. ${SIGN_IN_HINT}`);
    }

    if (opts.maxPrice !== undefined && dialog.priceMax !== undefined && opts.maxPrice >= dialog.priceMax) {
        throw new AlzaApiError(`The price limit must be below the current price (${dialog.priceMax}).`, 400);
    }

    const country = ctx.api.storefront.country;
    const created = watchdogCreatedSchema.parse(
        await ctx.api.json(z.unknown(), `${WEBAPI}/api/watchdog/v1?country=${country}&commodityClientId=${uid}`, {
            method: "POST",
            body: {
                commodityId: productId,
                email: dialog.email,
                isTrackingStock: trackingStock,
                price: opts.maxPrice ?? null,
            },
            withToken: true,
        })
    );
    logger.debug({ productId, trackingStock, maxPrice: opts.maxPrice }, "alza watchdog created");
    return {
        productId,
        created: {
            id: created?.watchdogId ?? undefined,
            productId,
            trackingStock: created?.isTrackingStock ?? trackingStock,
            maxPrice: created?.price ?? opts.maxPrice,
        },
    };
}

/** Removes a watchdog by its id (from `watchdog list`) or by the product it watches. */
export async function removeWatchdog(
    ctx: AccountContext,
    opts: { ref: string }
): Promise<{ removed: string; productId?: number }> {
    const uid = await userId(ctx);
    let watchdogId = WATCHDOG_ID.test(opts.ref.trim()) ? opts.ref.trim().toLowerCase() : undefined;
    let productId: number | undefined;
    if (!watchdogId) {
        productId = await resolveProductId(ctx.api, opts.ref);
        const dialog = await watchdogDialog(ctx, uid, productId);
        if (!dialog.exists) {
            throw new AlzaApiError(`No watchdog is set for product ${productId}.`, 404);
        }

        if (!dialog.existingId) {
            throw new AlzaApiError("Alza did not name the watchdog id; remove it by the id from `watchdog list`.", 404);
        }

        watchdogId = dialog.existingId;
    }

    const country = ctx.api.storefront.country;
    await ctx.api.json(
        z.unknown(),
        `${WEBAPI}/api/watchdog/v1/${watchdogId}?country=${country}&commodityClientId=${uid}`,
        { method: "DELETE", withToken: true }
    );
    logger.debug({ watchdogId, productId }, "alza watchdog removed");
    return { removed: watchdogId, productId };
}

export function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
