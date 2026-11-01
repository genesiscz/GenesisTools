import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";
import {
    type AccountContext,
    assertNoError,
    assertNotAnonymous,
    type CartView,
    type FavoritesView,
    LIST_TYPES,
    type ListName,
    listCommodityList,
    type OrderSummary,
    parseOrders,
    requireSignedIn,
    showCart,
    userId,
} from "./account";
import { AlzaApiError, APP_USER_AGENT, WEBAPI } from "./api";
import { resolveProductId } from "./catalog";

/**
 * The rest of the reference's safe account surface: profile, contacts, GDPR section, delivery and payment options,
 * order search and documents, warranty claims, subscription, address lookup, chatbot navigation, shopping-list
 * add/remove, the delivery-to-payment association, the checkout preview, and the raw read-only escape hatch.
 * Routes and their live notes: lukabudik/alza-mcp-community (MIT) — src/infra/mobile-api.ts and
 * docs/mobile-endpoint-coverage.md. Nothing here places an order, pays, or changes the account itself.
 */

const CHATBOT = "https://chatbotapi.alza.cz";
const envelopeSchema = z.object({
    err: z.number().nullish(),
    msg: z.string().nullish(),
    user_id: z.number().nullish(),
    basket_cnt: z.number().nullish(),
});

type Auth = "none" | "optional" | "required";

/** One read: sign-in rules, the token when there is one, and the legacy envelope checks when the answer has one. */
async function read(ctx: AccountContext, url: string, opts: { auth: Auth; what: string }): Promise<unknown> {
    if (opts.auth === "required") {
        requireSignedIn(ctx);
    }

    const raw = await ctx.api.json(z.unknown(), url, { withToken: opts.auth !== "none" });
    const envelope = envelopeSchema.safeParse(raw);
    if (envelope.success && opts.auth !== "none") {
        assertNotAnonymous(ctx, envelope.data, opts.what);
        assertNoError(envelope.data, opts.what);
    }

    return raw;
}

function stripHtml(text: string): string {
    return text
        .replace(/<br\s*\/?>/gi, ", ")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/** A compact markdown of an answer this tool does not model field by field: its scalar fields and list sizes. */
export function rawMarkdown(title: string, value: unknown): string {
    const lines = [`**${title}**`];
    if (typeof value !== "object" || value === null) {
        lines.push(String(value));
        return lines.join("\n");
    }

    for (const [key, field] of Object.entries(value)) {
        if (field === null || field === undefined || field === "") {
            continue;
        }

        if (Array.isArray(field)) {
            lines.push(`- ${key}: ${field.length} item(s)`);
        } else if (typeof field !== "object") {
            lines.push(`- ${key}: ${typeof field === "string" ? stripHtml(field).slice(0, 160) : String(field)}`);
        }
    }

    lines.push("", "The full answer is in `--json`.");
    return lines.join("\n");
}

// ── profile, contacts, GDPR, subscription ───────────────────────────────────

const PROFILE_FIELDS = ["user_id", "user_name", "name", "email", "phone", "street", "city", "zip"] as const;

export async function profile(ctx: AccountContext): Promise<{ summary: Record<string, string>; raw: unknown }> {
    const raw = await read(ctx, "/services/restservice.svc/v2/getUserData", { auth: "required", what: "the profile" });
    const summary: Record<string, string> = {};
    if (typeof raw === "object" && raw !== null) {
        for (const [key, value] of Object.entries(raw)) {
            if (
                (PROFILE_FIELDS as readonly string[]).includes(key) &&
                (typeof value === "string" || typeof value === "number") &&
                value !== ""
            ) {
                summary[key] = String(value);
            }
        }
    }

    return { summary, raw };
}

const contactsSchema = z.object({
    data: z
        .array(
            z.object({
                title: z.string().nullish(),
                text: z.string().nullish(),
                phone: z.string().nullish(),
                articleUrl: z.string().nullish(),
            })
        )
        .nullish(),
});

export interface Contact {
    title: string;
    text?: string;
    phone?: string;
    url?: string;
}

/** Alza's own contact channels (live 2026-11-01: answered for an anonymous visitor; not the account's address book). */
export async function contacts(ctx: AccountContext): Promise<Contact[]> {
    const answer = contactsSchema.parse(
        await read(ctx, "/services/restservice.svc/v4/contacts", { auth: "optional", what: "the contacts" })
    );
    return (answer.data ?? []).map((c) => ({
        title: c.title ?? "",
        text: c.text ? stripHtml(c.text) : undefined,
        phone: c.phone ?? undefined,
        url: c.articleUrl ?? undefined,
    }));
}

export async function gdprInfo(ctx: AccountContext): Promise<{ personalDetails: unknown; gdprDialog: unknown }> {
    const uid = await userId(ctx);
    const country = ctx.api.storefront.country;
    const personalDetails = await read(
        ctx,
        `${WEBAPI}/api/users/${uid}/v1/userAccount/personalDetails?country=${country}`,
        {
            auth: "required",
            what: "the GDPR section",
        }
    );
    let gdprDialog: unknown = null;
    try {
        gdprDialog = await read(ctx, `${WEBAPI}/api/users/${uid}/v1/userAccount/gdprDialog`, {
            auth: "required",
            what: "the GDPR dialog",
        });
    } catch (error) {
        logger.debug({ error }, "alza GDPR dialog read failed; the section is still returned");
        gdprDialog = { error: error instanceof Error ? error.message : String(error) };
    }

    return { personalDetails, gdprDialog };
}

/** Row S1 in the reference. Signed in on 2026-11-01 it answered a form (`self`, `form.value[]`), not a summary, so it stays raw. */
export async function subscriptionOverview(ctx: AccountContext): Promise<unknown> {
    const uid = await userId(ctx);
    return read(ctx, `${WEBAPI}/api/users/${uid}/v1/subscription?country=${ctx.api.storefront.country}`, {
        auth: "required",
        what: "the subscription",
    });
}

// ── delivery and payment options ────────────────────────────────────────────

const deliveryItemSchema = z.object({
    id: z.number(),
    name: z.string().nullish(),
    itemType: z.string().nullish(),
    group: z.string().nullish(),
    groupName: z.string().nullish(),
    price: z.string().nullish(),
    priceDecimal: z.number().nullish(),
    parentId: z.number().nullish(),
});

const deliveryGroupsSchema = z.object({
    deliveryGroups: z
        .array(z.object({ deliveryGroupId: z.number(), deliveries: z.array(deliveryItemSchema).nullish() }))
        .nullish(),
    payments: z.array(deliveryItemSchema).nullish(),
    warnings: z.array(z.string()).nullish(),
    err: z.number().nullish(),
    msg: z.string().nullish(),
    user_id: z.number().nullish(),
    basket_cnt: z.number().nullish(),
});

export interface DeliveryOption {
    id: number;
    name: string;
    type?: string;
    price?: string;
    priceValue?: number;
}

export interface DeliveryOptions {
    groups: Array<{ id: number; deliveries: DeliveryOption[] }>;
    payments: Array<DeliveryOption & { group?: string }>;
    warnings: string[];
}

function toOption(item: z.infer<typeof deliveryItemSchema>): DeliveryOption {
    return {
        id: item.id,
        name: item.name ?? `option ${item.id}`,
        type: item.itemType ?? undefined,
        price: item.price ?? undefined,
        priceValue: item.priceDecimal ?? undefined,
    };
}

export function parseDeliveryGroups(answer: z.infer<typeof deliveryGroupsSchema>): DeliveryOptions {
    return {
        groups: (answer.deliveryGroups ?? []).map((group) => ({
            id: group.deliveryGroupId,
            deliveries: (group.deliveries ?? []).filter((d) => !d.parentId).map(toOption),
        })),
        payments: (answer.payments ?? []).map((p) => ({ ...toOption(p), group: p.groupName ?? p.group ?? undefined })),
        warnings: (answer.warnings ?? []).map(stripHtml).filter(Boolean),
    };
}

/** getDeliveryPaymentGroups for the current basket (the account's or the visitor's). App 2026.17 calls v13; v12 is the fallback. */
export async function deliveryOptions(
    ctx: AccountContext,
    opts: { deliveryOptionId?: number } = {}
): Promise<DeliveryOptions> {
    const query = opts.deliveryOptionId === undefined ? "" : `?selectedDeliveryOptionId=${opts.deliveryOptionId}`;
    let answer: z.infer<typeof deliveryGroupsSchema>;
    try {
        answer = await ctx.api.json(
            deliveryGroupsSchema,
            `/services/restservice.svc/v13/getDeliveryPaymentGroups${query}`,
            {
                withToken: true,
            }
        );
    } catch (error) {
        if (!(error instanceof AlzaApiError && error.status === 404)) {
            throw error;
        }

        answer = await ctx.api.json(
            deliveryGroupsSchema,
            `/services/restservice.svc/v12/getDeliveryPaymentGroups${query}`,
            {
                withToken: true,
            }
        );
    }

    assertNotAnonymous(ctx, answer, "the delivery options");
    if (answer.err && answer.basket_cnt === 0) {
        throw new AlzaApiError(
            "The basket is empty: delivery and payment options exist only for a basket with products.",
            400
        );
    }

    assertNoError(answer, "the delivery options");
    return parseDeliveryGroups(answer);
}

const associationsSchema = z.object({
    data: z
        .array(
            z.object({
                id: z.number(),
                price: z.union([z.string(), z.number()]).nullish(),
                paymentPrice: z.union([z.string(), z.number()]).nullish(),
                isHidden: z.boolean().nullish(),
            })
        )
        .nullish(),
    err: z.number().nullish(),
    msg: z.string().nullish(),
    user_id: z.number().nullish(),
});

/**
 * Despite the reference's tool name, this does not pick an AlzaBox: it asks which payments fit one delivery and what
 * that delivery then costs (`getDeliveryAssociations`). The reference saw no change to the basket from it (2026-10-06).
 */
export async function selectPickupPoint(
    ctx: AccountContext,
    opts: { deliveryId: number; deliveryGroupId?: number; parcelShopId?: number }
): Promise<{
    deliveryGroupId: number;
    deliveryId: number;
    payments: Array<{ id: number; name?: string; price?: string; paymentPrice?: string }>;
}> {
    const options = await deliveryOptions(ctx);
    const group =
        opts.deliveryGroupId ?? options.groups.find((g) => g.deliveries.some((d) => d.id === opts.deliveryId))?.id;
    if (group === undefined) {
        throw new AlzaApiError(
            `Delivery ${opts.deliveryId} is not among the basket's delivery options (see \`checkout delivery\`).`,
            404
        );
    }

    const answer = await ctx.api.json(associationsSchema, "/services/restservice.svc/v4/getDeliveryAssociations", {
        method: "POST",
        body: {
            cardId: 0,
            deliveryGroups: [
                {
                    deliveryGroupId: group,
                    deliveryId: opts.deliveryId,
                    parcelShopId: opts.parcelShopId ?? 0,
                    deliveryServicesIds: [],
                    timeFrameId: 0,
                    timeSlotId: 0,
                },
            ],
        },
        withToken: true,
    });
    assertNotAnonymous(ctx, answer, "the delivery association");
    assertNoError(answer, "the delivery association");
    const names = new Map(options.payments.map((p) => [p.id, p.name]));
    return {
        deliveryGroupId: group,
        deliveryId: opts.deliveryId,
        payments: (answer.data ?? [])
            .filter((p) => !p.isHidden)
            .map((p) => ({
                id: p.id,
                name: names.get(p.id),
                price: p.price === null || p.price === undefined ? undefined : String(p.price),
                paymentPrice:
                    p.paymentPrice === null || p.paymentPrice === undefined ? undefined : String(p.paymentPrice),
            })),
    };
}

/**
 * The read side of the mobile checkout: `sendOrder1` (which starts Alza's server-side checkout state, so it is not
 * read-only), the delivery and payment groups, and the basket. It never submits anything: this tool has no order step.
 */
export async function checkoutPreview(
    ctx: AccountContext,
    opts: { deliveryOptionId?: number } = {}
): Promise<{ cart: CartView; options: DeliveryOptions; checkoutState: unknown }> {
    const cart = await showCart(ctx);
    if (cart.items.length === 0) {
        throw new AlzaApiError("The basket is empty: there is nothing to preview.", 400);
    }

    const checkoutState = await read(ctx, "/services/restservice.svc/v4/sendOrder1", {
        auth: "optional",
        what: "the checkout step",
    });
    const options = await deliveryOptions(ctx, opts);
    return { cart, options, checkoutState };
}

export async function afterOrderPayments(
    ctx: AccountContext,
    opts: { orderId: string; partId: string }
): Promise<unknown> {
    for (const value of [opts.orderId, opts.partId]) {
        if (!/^\d{1,16}$/.test(value)) {
            throw new AlzaApiError(`"${value}" is not an order or part number (digits only).`, 400);
        }
    }

    return read(ctx, `/services/restservice.svc/v2/getafterorderpayments/${opts.orderId}/${opts.partId}`, {
        auth: "optional",
        what: "the after-order payments",
    });
}

// ── orders: search, documents ───────────────────────────────────────────────

/** Row OR6: the orders search form. The reference sends it form-urlencoded and saw JSON answer 200 too; JSON is sent here. */
export async function orderSearch(ctx: AccountContext, term: string): Promise<{ orders: OrderSummary[] }> {
    const searchTerm = term.trim();
    if (searchTerm.length === 0 || searchTerm.length > 64) {
        throw new AlzaApiError("The search term must be 1-64 characters (an order number or a product name).", 400);
    }

    requireSignedIn(ctx);
    const uid = await userId(ctx);
    const raw = await ctx.api.json(
        z.unknown(),
        `/api/users/${uid}/v1/orders/search/results?country=${ctx.api.storefront.country}`,
        {
            method: "POST",
            body: { searchTerm, productFilterType: 0 },
            withToken: true,
        }
    );
    return { orders: parseOrders(raw, "search").orders };
}

/** The hosts an order document may come from (invoices live on pdf.alza.cz); adapted from the reference's DOCUMENT_HOSTS. */
export const DOCUMENT_HOSTS = new Set([
    "alza.cz",
    "www.alza.cz",
    "m.alza.cz",
    "webapi.alza.cz",
    "api.alza.cz",
    "pdf.alza.cz",
]);
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
/** The whole download, body included. */
const DOCUMENT_TIMEOUT_MS = 30_000;
/** The invoice host serves documents only, so any path there is a document. */
const PDF_HOST = "pdf.alza.cz";
/**
 * On the other hosts a GET with the account token can do more than read (`sendOrder1` starts checkout state), so only
 * the routes of one order of the account are followed: where order responses link their documents.
 */
const ORDER_DOCUMENT_PATH = /^\/api\/users\/\d{1,16}\/v\d{1,2}\/orders\/\d{6,16}(?:\/[\w.-]+)*\/?$/;

/**
 * An absolute https URL with no credentials in it: any path on pdf.alza.cz, or one order's route on another Alza
 * document host. Throws with the reason otherwise.
 */
export function validateDocumentUrl(href: string): URL {
    let url: URL;
    try {
        url = new URL(href.trim());
    } catch (error) {
        logger.debug({ error }, "alza document href is not a URL");
        throw new AlzaApiError("The document link must be an absolute URL (copy it from `orders search --json`).", 400);
    }

    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") {
        throw new AlzaApiError("The document link must be a plain https URL.", 400);
    }

    if (!DOCUMENT_HOSTS.has(url.hostname)) {
        throw new AlzaApiError(
            `${url.hostname} is not an Alza document host (${[...DOCUMENT_HOSTS].join(", ")}).`,
            400
        );
    }

    if (url.hostname !== PDF_HOST && !ORDER_DOCUMENT_PATH.test(url.pathname)) {
        throw new AlzaApiError(
            `${url.pathname} on ${url.hostname} is not an order document route; only ${PDF_HOST} links and /api/users/<id>/v1/orders/<order>/… links are followed.`,
            400
        );
    }

    return url;
}

/** The body, read chunk by chunk and given up as soon as it passes `maxBytes`, so a large answer is never buffered. */
async function readBodyWithin(response: Response, maxBytes: number): Promise<Uint8Array> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel();
        throw new AlzaApiError(`The document is larger than ${maxBytes} bytes (${declared}); not saved.`, 413);
    }

    const reader = response.body?.getReader();
    if (!reader) {
        return new Uint8Array(0);
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    let chunk = await reader.read();
    while (!chunk.done) {
        total += chunk.value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            throw new AlzaApiError(`The document is larger than ${maxBytes} bytes; not saved.`, 413);
        }

        chunks.push(chunk.value);
        chunk = await reader.read();
    }

    return Buffer.concat(chunks);
}

/** pdf.alza.cz with plain fetch: no redirect is followed, and the deadline covers the body as well. */
async function fetchPdfDocument(
    url: URL,
    headers: Record<string, string>
): Promise<{ body: Uint8Array; contentType?: string }> {
    try {
        const response = await fetch(url, {
            headers,
            redirect: "manual",
            signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS),
        });
        if (response.status >= 300 && response.status < 400) {
            throw new AlzaApiError(
                `The document link redirected to ${response.headers.get("location") ?? "?"}; not followed.`,
                response.status
            );
        }

        if (!response.ok) {
            throw new AlzaApiError(`${PDF_HOST} answered HTTP ${response.status} for the document.`, response.status);
        }

        const contentType = response.headers.get("content-type") ?? undefined;
        return { body: await readBodyWithin(response, MAX_DOCUMENT_BYTES), contentType };
    } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
            throw new AlzaApiError(
                `${PDF_HOST} did not send the document within ${DOCUMENT_TIMEOUT_MS / 1000} s.`,
                504
            );
        }

        throw error;
    }
}

/**
 * Downloads an order document to a file. pdf.alza.cz answers a plain fetch (live 2026-11-01: a real 404 page, not the
 * Cloudflare challenge) and serves binary PDFs, which the Chrome-fingerprint client would decode as text; so that host
 * is read with fetch. The other Alza hosts go through the fingerprint client and must answer a text document.
 * Redirects are refused, so the Bearer token never follows to another host.
 */
export async function orderDocument(
    ctx: AccountContext,
    opts: { href: string; output: string; overwrite?: boolean }
): Promise<{ path: string; bytes: number; contentType?: string }> {
    const url = validateDocumentUrl(opts.href);
    const path = resolve(opts.output);
    if (existsSync(path) && !opts.overwrite) {
        throw new AlzaApiError(`${path} already exists. Pass overwrite to replace it.`, 409);
    }

    const token = await ctx.auth.accessToken();
    const headers: Record<string, string> = {
        accept: "application/pdf, application/json, application/xml, text/plain, application/octet-stream",
        "accept-language": ctx.api.storefront.acceptLanguage,
        "user-agent": APP_USER_AGENT,
        "Balancer-Guid": ctx.api.visitorId,
    };
    if (token) {
        headers.authorization = `Bearer ${token}`;
    }

    let body: Uint8Array;
    let contentType: string | undefined;
    if (url.hostname === PDF_HOST) {
        ({ body, contentType } = await fetchPdfDocument(url, headers));
    } else {
        const response = await ctx.api.http.request({
            url: url.toString(),
            headers,
            followRedirects: false,
            timeoutMs: DOCUMENT_TIMEOUT_MS,
            maxBodyBytes: MAX_DOCUMENT_BYTES,
        });
        if (response.status < 200 || response.status >= 300) {
            throw new AlzaApiError(
                `${url.hostname} answered HTTP ${response.status} for the document.`,
                response.status
            );
        }

        contentType = response.headers["content-type"];
        if (contentType && !/text|json|xml/i.test(contentType)) {
            throw new AlzaApiError(
                `${url.hostname} answered ${contentType}; only pdf.alza.cz documents can be saved as binary.`,
                415
            );
        }

        body = new TextEncoder().encode(response.text);
    }

    if (body.byteLength > MAX_DOCUMENT_BYTES) {
        throw new AlzaApiError(`The document is larger than ${MAX_DOCUMENT_BYTES} bytes; not saved.`, 413);
    }

    await Bun.write(path, body);
    logger.debug({ host: url.hostname, path, bytes: body.byteLength, contentType }, "alza order document saved");
    return { path, bytes: body.byteLength, contentType };
}

// ── warranty claims ─────────────────────────────────────────────────────────

const CLAIM_HOSTS = new Set(["www.alza.cz", "m.alza.cz", "webapi.alza.cz"]);
const WARRANTY_CLAIMS_PATH = /^\/api\/users\/\d{1,16}\/v1\/warrantyClaims(?:\/[\w-]+)*\/?$/;

export async function complaintClaims(ctx: AccountContext, scope: "active" | "archive"): Promise<unknown> {
    const uid = await userId(ctx);
    return read(ctx, `/api/users/${uid}/v1/warrantyClaims/${scope}?country=${ctx.api.storefront.country}`, {
        auth: "required",
        what: "the warranty claims",
    });
}

/** A claim's `detailAction.href`: https, an Alza API host, and the account's warranty-claims route family only. */
export function validateClaimLink(href: string): URL {
    let url: URL;
    try {
        url = new URL(href.trim());
    } catch (error) {
        logger.debug({ error }, "alza claim href is not a URL");
        throw new AlzaApiError(
            "The claim link must be an absolute URL (the detailAction href from `account claims`).",
            400
        );
    }

    if (
        url.protocol !== "https:" ||
        url.username !== "" ||
        url.password !== "" ||
        url.port !== "" ||
        !CLAIM_HOSTS.has(url.hostname)
    ) {
        throw new AlzaApiError(`The claim link must be an https URL on ${[...CLAIM_HOSTS].join(", ")}.`, 400);
    }

    if (!WARRANTY_CLAIMS_PATH.test(url.pathname)) {
        throw new AlzaApiError("The claim link is outside the warranty-claims routes.", 400);
    }

    return url;
}

export async function claimDetail(ctx: AccountContext, href: string): Promise<unknown> {
    const url = validateClaimLink(href);
    return read(ctx, url.toString(), { auth: "required", what: "the claim detail" });
}

// ── lookups without a sign-in ───────────────────────────────────────────────

const zipCodesSchema = z.object({
    zipCodes: z
        .array(z.object({ id: z.number().nullish(), zip: z.string().nullish(), city: z.string().nullish() }))
        .nullish(),
});

export async function addressSearch(
    ctx: AccountContext,
    query: string
): Promise<Array<{ zip: string; city: string; id?: number }>> {
    const search = query.trim();
    if (search.length === 0 || search.length > 50) {
        throw new AlzaApiError("The query must be 1-50 characters (a postal code or a place).", 400);
    }

    const answer = await ctx.api.json(
        zipCodesSchema,
        `/services/restservice.svc/v1/getZipCodes?${new URLSearchParams({ deliveryId: "0", search })}`
    );
    return (answer.zipCodes ?? []).map((z) => ({ zip: z.zip ?? "", city: z.city ?? "", id: z.id ?? undefined }));
}

export async function chatNavigation(ctx: AccountContext): Promise<Array<{ name: string; href?: string }>> {
    const raw = await ctx.api.json(
        z.record(z.string(), z.unknown()),
        `${CHATBOT}/api/visitors/${ctx.api.visitorId}/v1/navigation?country=${ctx.api.storefront.country}`
    );
    const actionSchema = z.object({ href: z.string().nullish(), appLink: z.string().nullish() });
    return Object.entries(raw).flatMap(([name, value]) => {
        const action = actionSchema.safeParse(value);
        return action.success && value ? [{ name, href: action.data.href ?? undefined }] : [];
    });
}

// ── shopping lists ──────────────────────────────────────────────────────────

/** Adds a product to, or removes it from, the favourites or the buy-later list. Works for the visitor too. */
export async function mutateList(
    ctx: AccountContext,
    opts: { action: "add" | "remove"; product: string; list: ListName }
): Promise<{ action: "add" | "remove"; productId: number; list: FavoritesView }> {
    const productId = await resolveProductId(ctx.api, opts.product);
    if (opts.action === "add") {
        const answer = await ctx.api.json(envelopeSchema, "/services/restservice.svc/v2/addCommodityToList", {
            method: "POST",
            body: { productId, commodityListType: LIST_TYPES[opts.list] },
            withToken: true,
        });
        assertNotAnonymous(ctx, answer, "the list change");
        assertNoError(answer, "the list change");
    } else {
        const current = await listCommodityList(ctx, opts.list);
        const list = current.lists.find((l) => l.items.some((item) => item.id === productId));
        if (!list) {
            throw new AlzaApiError(`Product ${productId} is not in the ${opts.list} list.`, 404);
        }

        const answer = await ctx.api.json(envelopeSchema, "/services/restservice.svc/v2/deleteCommodityFromList", {
            method: "POST",
            body: { id: list.id, productId },
            withToken: true,
        });
        assertNotAnonymous(ctx, answer, "the list change");
        assertNoError(answer, "the list change");
    }

    logger.debug({ action: opts.action, productId, list: opts.list }, "alza list changed");
    return { action: opts.action, productId, list: await listCommodityList(ctx, opts.list) };
}

// ── mobile_read: fixed GET operations ───────────────────────────────────────

interface RawRead {
    description: string;
    params: readonly string[];
    auth: Auth;
    url(ctx: AccountContext, args: Record<string, string>, uid: () => Promise<number>): string | Promise<string>;
}

const legacy = (path: string) => `/services/restservice.svc/${path}`;
const digits = (value: string, name: string): string => {
    if (!/^\d{1,16}$/.test(value)) {
        throw new AlzaApiError(`${name} must be a number, got "${value}".`, 400);
    }

    return value;
};

/**
 * The raw reads, each a fixed GET route on a fixed Alza host (www, webapi, chatbotapi). No caller-supplied URL ever
 * reaches the network, and nothing here writes. Adapted from the reference's `mobile_read` operation table.
 */
export const RAW_READS = {
    router_product: {
        description: "Full product envelope, parameterGroups included {product_id}",
        params: ["product_id"],
        auth: "none",
        url: (_ctx, a) => `/api/router/legacy/catalog/product/${digits(a.product_id ?? "", "product_id")}`,
    },
    alternatives: {
        description: "Alza's alternatives list {commodity_id}",
        params: ["commodity_id"],
        auth: "none",
        url: (_ctx, a) => legacy(`v1/alternatives/${digits(a.commodity_id ?? "", "commodity_id")}`),
    },
    category: {
        description: "One category level {category_id}",
        params: ["category_id"],
        auth: "none",
        url: (_ctx, a) => legacy(`v1/category/${digits(a.category_id ?? "", "category_id")}?T=CATEGORY&P=0`),
    },
    facets: {
        description: "A category's parameter facets {category_id}",
        params: ["category_id"],
        auth: "none",
        url: (_ctx, a) =>
            legacy(`v3/params/${digits(a.category_id ?? "", "category_id")}?type=CATEGORY&typeId=0&search=`),
    },
    discussion_posts: {
        description: "Question posts of a product {commodity_id}",
        params: ["commodity_id"],
        auth: "none",
        url: (_ctx, a) =>
            legacy(
                `v1/getCommodityDiscussionPosts?id=${digits(a.commodity_id ?? "", "commodity_id")}&pageStart=0&pageSize=20`
            ),
    },
    delivery_countries: {
        description: "Delivery countries",
        params: [],
        auth: "none",
        url: () => legacy("v1/getAllDeliveryCountries"),
    },
    zip_codes: {
        description: "Postal codes {query?}",
        params: [],
        auth: "none",
        url: (_ctx, a) => legacy(`v1/getZipCodes?${new URLSearchParams({ deliveryId: "0", search: a.query ?? "" })}`),
    },
    branches: {
        description: "Alza shops near a point {latitude, longitude}",
        params: ["latitude", "longitude"],
        auth: "none",
        url: (_ctx, a) => {
            const lat = Number(a.latitude);
            const lon = Number(a.longitude);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
                throw new AlzaApiError("latitude and longitude must be numbers.", 400);
            }

            return `/api/branches/v1/cityBranches?latitude=${lat}&longitude=${lon}`;
        },
    },
    order_helpdesk_questions: {
        description: "Order helpdesk questions",
        params: [],
        auth: "none",
        url: () => "/api/orders/v1/helpdesk/questions",
    },
    anonymous_order: {
        description: "An order read without a sign-in {order_id}",
        params: ["order_id"],
        auth: "none",
        url: (_ctx, a) => `/api/anonymous/v1/orders/${digits(a.order_id ?? "", "order_id")}`,
    },
    visitor_navigation: {
        description: "The visitor's main navigation",
        params: [],
        auth: "none",
        url: (ctx) =>
            `${WEBAPI}/api/visitors/${ctx.api.visitorId}/mainNavigation?country=${ctx.api.storefront.country}`,
    },
    chat_navigation: {
        description: "The chatbot navigation",
        params: [],
        auth: "none",
        url: (ctx) =>
            `${CHATBOT}/api/visitors/${ctx.api.visitorId}/v1/navigation?country=${ctx.api.storefront.country}`,
    },
    basket_info: { description: "Basket summary", params: [], auth: "optional", url: () => legacy("v3/basketInfo") },
    cart: {
        description: "Basket lines (gridOrder1)",
        params: [],
        auth: "optional",
        url: () => legacy("v10/gridOrder1"),
    },
    commodity_lists: {
        description: "Shopping lists {type?}",
        params: [],
        auth: "optional",
        url: (_ctx, a) => legacy(`v1/getCommodityLists${a.type ? `?type=${digits(a.type, "type")}` : ""}`),
    },
    order_add_info: {
        description: "Checkout state of the basket",
        params: [],
        auth: "optional",
        url: () => legacy("v2/getOrderAddInfo?isGiftsEnabled=true"),
    },
    order2_info: {
        description: "Checkout step 2 info",
        params: [],
        auth: "optional",
        url: (ctx) => legacy(`v8/getOrder2Info?country=${ctx.api.storefront.country}`),
    },
    order_part: {
        description: "One part of an order {order_id, part_id}",
        params: ["order_id", "part_id"],
        auth: "optional",
        url: (_ctx, a) =>
            `/api/v1/orders/${digits(a.order_id ?? "", "order_id")}/${digits(a.part_id ?? "", "part_id")}`,
    },
    user_data: {
        description: "The account's user data",
        params: [],
        auth: "required",
        url: () => legacy("v2/getUserData"),
    },
    user_navigation: {
        description: "The signed-in main navigation",
        params: [],
        auth: "required",
        url: async (ctx, _a, uid) =>
            `${WEBAPI}/api/users/${await uid()}/mainNavigation?country=${ctx.api.storefront.country}`,
    },
} satisfies Record<string, RawRead>;

export type RawReadName = keyof typeof RAW_READS;
export const RAW_READ_NAMES = Object.keys(RAW_READS) as [RawReadName, ...RawReadName[]];

export async function mobileRead(
    ctx: AccountContext,
    opts: { operation: RawReadName; args?: Record<string, string> }
): Promise<unknown> {
    const op: RawRead = RAW_READS[opts.operation];
    const args = opts.args ?? {};
    const missing = op.params.filter((name) => !args[name]);
    if (missing.length > 0) {
        throw new AlzaApiError(`${opts.operation} needs: ${missing.join(", ")}.`, 400);
    }

    const url = await op.url(ctx, args, () => userId(ctx));
    logger.debug({ operation: opts.operation }, "alza raw read");
    return read(ctx, url, { auth: op.auth, what: opts.operation });
}
