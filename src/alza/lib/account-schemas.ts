import { z } from "zod";

/**
 * Shapes of the signed-in account routes and of this tool's own account files. Like `schemas.ts`, unknown fields are
 * stripped and every field Alza may omit is optional. Route inventory: lukabudik/alza-mcp-community
 * docs/mobile-endpoint-coverage.md (MIT); the basket remove route (`EShopService.svc/OrderUpdate`) was read from the
 * `updateAction` form of the web basket add on 2026-11-01.
 */

const optStr = z.string().nullish();
const optNum = z.number().nullish();
const optBool = z.boolean().nullish();

// ── this tool's files ────────────────────────────────────────────────────────

export const storedTokensSchema = z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    token_type: z.string().default("Bearer"),
    scope: z.string().optional(),
    /** ISO time the access token stops working (JWT `exp`, else obtained_at + expires_in). */
    expires_at: z.string().optional(),
    obtained_at: z.string(),
    /** The numeric Alza user id, read from getUserData once after sign-in. */
    user_id: z.number().int().positive().optional(),
});
export type StoredTokens = z.infer<typeof storedTokensSchema>;

export const pendingLoginSchema = z.object({
    verifier: z.string().min(43),
    state: z.string().min(16),
    created_at: z.string(),
    token_endpoint: z.url(),
});
export type PendingLogin = z.infer<typeof pendingLoginSchema>;

export const visitorStateSchema = z.object({
    visitorId: z.uuid(),
    cookies: z.record(z.string(), z.string()).default({}),
});
export type VisitorState = z.infer<typeof visitorStateSchema>;

// ── identity.alza.cz ─────────────────────────────────────────────────────────

export const discoverySchema = z.object({
    authorization_endpoint: z.url(),
    token_endpoint: z.url(),
});

export const tokenResponseSchema = z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().optional(),
    token_type: z.string().optional(),
    scope: z.string().optional(),
});

// ── legacy restservice envelope (every /services/restservice.svc answer) ────

const envelope = {
    err: optNum,
    msg: optStr,
    /** -1 means Alza answered as the anonymous visitor. */
    user_id: optNum,
    user_name: optStr,
    basket_cnt: optNum,
    favCnt: optNum,
};

export const userDataSchema = z.object(envelope);

const gridLineSchema = z.object({
    orderItemId: z.number(),
    commodityId: optNum,
    parentId: optNum,
    code: optStr,
    name: optStr,
    count: optNum,
    priceVat: optStr,
    pricePerItemVat: optStr,
    priceNoCurrency: optNum,
    currency: optStr,
    availability: z.array(z.object({ AvailAbility: optStr })).nullish(),
});
export type GridLine = z.infer<typeof gridLineSchema>;

export const gridOrderSchema = z.object({
    ...envelope,
    data: z.array(gridLineSchema).nullish(),
    price_pay: optStr,
    pricePayAmt: optNum,
    priceVat: optStr,
});
export type GridOrder = z.infer<typeof gridOrderSchema>;

export const basketAddSchema = z.object({
    ...envelope,
    data: z.object({ orderItemId: optNum, code: optStr, name: optStr, count: optNum, commodityId: optNum }).nullish(),
});

export const orderUpdateSchema = z.object({
    d: z.object({
        Count: optNum,
        BasketPrice: optNum,
        ErrorLevel: optNum,
        Message: optStr,
    }),
});

const favoriteItemSchema = z.object({
    id: z.number(),
    code: optStr,
    name: optStr,
    price: optStr,
    cprice: optStr,
    priceNoCurrency: optNum,
    avail: optStr,
    navigationUrl: optStr,
    can_buy: optBool,
    count: optNum,
});

export const commodityListsSchema = z.object({
    ...envelope,
    data: z
        .array(
            z.object({
                id: z.number(),
                name: optStr,
                itemCount: optNum,
                type: optNum,
                items: z.array(favoriteItemSchema).nullish(),
            })
        )
        .nullish(),
});

// ── hypermedia routes (watchdogs, orders) ────────────────────────────────────

const formFieldSchema = z.object({ name: z.string(), value: z.unknown().optional(), max: optNum });
const hyperSchema = z
    .object({
        href: optStr,
        value: z.array(formFieldSchema).nullish(),
        form: z.object({ href: optStr, value: z.array(formFieldSchema).nullish() }).nullish(),
    })
    .nullish();
export type Hyper = z.infer<typeof hyperSchema>;

export const watchdogDialogSchema = z.object({ form: hyperSchema, deleteAction: hyperSchema });
export type WatchdogDialogRaw = z.infer<typeof watchdogDialogSchema>;

export const watchdogListSchema = z.object({
    value: z
        .array(
            z.object({
                commodityName: optStr,
                commodityUrl: optStr,
                commodityDetail: hyperSchema,
                priceInfoV2: z.object({ priceNoCurrency: optNum }).nullish(),
                availabilityText: optStr,
                updateForm: hyperSchema,
                deleteAction: hyperSchema,
            })
        )
        .nullish(),
    paging: z.object({ next: z.unknown().nullish() }).nullish(),
    emptyInfo: z.object({ message: optStr }).nullish(),
});
export type WatchdogListRaw = z.infer<typeof watchdogListSchema>;

/** The create answer also echoes the account email; it is stripped here and never printed. */
export const watchdogCreatedSchema = z
    .object({
        watchdogId: optStr,
        commodityId: optNum,
        isTrackingStock: optBool,
        price: optNum,
        created: optStr,
    })
    .nullish();

const orderPartSchema = z.object({
    partNumber: optStr,
    partName: optStr,
    status: optStr,
    created: optStr,
});

/** One order in the active/archive lists and the order detail. Read leniently: the list items were never seen live. */
export const orderSchema = z.object({
    orderId: z.union([z.string(), z.number()]).nullish(),
    orderNumber: optStr,
    orderName: optStr,
    orderTypeName: optStr,
    created: optStr,
    status: optStr,
    totalPrice: z.union([z.string(), z.number()]).nullish(),
    price: z.union([z.string(), z.number()]).nullish(),
    parts: z.array(orderPartSchema).nullish(),
    /** An optional extra: a documents list of another shape becomes null instead of dropping the whole order. */
    documents: z
        .array(z.object({ name: optStr, self: hyperSchema }))
        .nullish()
        .catch(null),
    self: hyperSchema,
});
export type OrderRaw = z.infer<typeof orderSchema>;

export const ordersPageSchema = z.object({
    value: z.array(z.unknown()).nullish(),
    orders: z.array(z.unknown()).nullish(),
    paging: z.object({ next: z.unknown().nullish() }).nullish(),
});
