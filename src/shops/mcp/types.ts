import { z } from "zod";

export interface JsonSchema {
    type: "object";
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
}

export interface JsonSchemaProperty {
    type: "string" | "number" | "integer" | "boolean" | "array" | "object";
    description?: string;
    items?: JsonSchemaProperty;
    minimum?: number;
    maximum?: number;
    minLength?: number;
}

export const ShopsGetProductInput = z
    .object({
        url: z.url().optional(),
        shop: z.string().min(1).optional(),
        slug: z.string().min(1).optional(),
    })
    .refine((v) => v.url !== undefined || (v.shop !== undefined && v.slug !== undefined), {
        message: "Provide either {url} or both {shop, slug}",
    });
export type ShopsGetProductInputT = z.infer<typeof ShopsGetProductInput>;
export const ShopsGetProductInputJsonSchema: JsonSchema = {
    type: "object",
    properties: {
        url: { type: "string", description: "Canonical product URL on a supported shop" },
        shop: { type: "string", description: "Shop origin, e.g. 'rohlik.cz'" },
        slug: { type: "string", description: "Product slug (or itemId for shops where slug == id)" },
    },
};

export const ShopsMatchProductInput = z.object({
    url: z.url(),
});
export type ShopsMatchProductInputT = z.infer<typeof ShopsMatchProductInput>;
export const ShopsMatchProductInputJsonSchema: JsonSchema = {
    type: "object",
    properties: {
        url: { type: "string", description: "Canonical product URL on a supported shop" },
    },
    required: ["url"],
};

export const ShopsSearchInput = z.object({
    query: z.string().trim().min(1),
    shop: z.string().min(1).optional(),
    category: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).default(25),
});
export type ShopsSearchInputT = z.infer<typeof ShopsSearchInput>;
export const ShopsSearchInputJsonSchema: JsonSchema = {
    type: "object",
    properties: {
        query: { type: "string", description: "Free-text query; FTS5 prefix-matches each token" },
        shop: { type: "string", description: "Filter to one shop origin" },
        category: { type: "string", description: "Filter to a category id within the chosen shop" },
        limit: { type: "integer", description: "Max rows (1-200, default 25)", minimum: 1, maximum: 200 },
    },
    required: ["query"],
};

export const ShopsListCategoriesInput = z.object({
    shop: z.string().min(1),
});
export type ShopsListCategoriesInputT = z.infer<typeof ShopsListCategoriesInput>;
export const ShopsListCategoriesInputJsonSchema: JsonSchema = {
    type: "object",
    properties: { shop: { type: "string", description: "Shop origin, e.g. 'rohlik.cz'" } },
    required: ["shop"],
};

export const ShopsComparePricesInput = z.object({
    masterIds: z.array(z.number().int().positive()).min(1).max(50),
});
export type ShopsComparePricesInputT = z.infer<typeof ShopsComparePricesInput>;
export const ShopsComparePricesInputJsonSchema: JsonSchema = {
    type: "object",
    properties: {
        masterIds: {
            type: "array",
            items: { type: "integer" },
            description: "1-50 master_product ids",
        },
    },
    required: ["masterIds"],
};

export const ShopsCoverageInput = z.object({}).strict();
export type ShopsCoverageInputT = z.infer<typeof ShopsCoverageInput>;
export const ShopsCoverageInputJsonSchema: JsonSchema = {
    type: "object",
    properties: {},
};

export const ShopsWatchListInput = z.object({}).strict();
export type ShopsWatchListInputT = z.infer<typeof ShopsWatchListInput>;
export const ShopsWatchListInputJsonSchema: JsonSchema = {
    type: "object",
    properties: {},
};

export const ShopsRecentNotificationsInput = z.object({
    limit: z.number().int().min(1).max(500).default(100),
    since: z
        .string()
        .refine((s) => !Number.isNaN(Date.parse(s)), { message: "since must be ISO-8601 parseable" })
        .optional(),
});
export type ShopsRecentNotificationsInputT = z.infer<typeof ShopsRecentNotificationsInput>;
export const ShopsRecentNotificationsInputJsonSchema: JsonSchema = {
    type: "object",
    properties: {
        limit: {
            type: "integer",
            description: "Max notifications (default 100, max 500)",
            minimum: 1,
            maximum: 500,
        },
        since: { type: "string", description: "ISO-8601 lower bound on fired_at" },
    },
};

export const ShopsIngestInput = z.object({
    url: z.url(),
});
export type ShopsIngestInputT = z.infer<typeof ShopsIngestInput>;
export const ShopsIngestInputJsonSchema: JsonSchema = {
    type: "object",
    properties: { url: { type: "string", description: "Product URL to ingest into the local DB" } },
    required: ["url"],
};

export const ShopsAcceptMatchInput = z.object({
    productIdA: z.number().int().positive(),
    productIdB: z.number().int().positive(),
});
export type ShopsAcceptMatchInputT = z.infer<typeof ShopsAcceptMatchInput>;
export const ShopsAcceptMatchInputJsonSchema: JsonSchema = {
    type: "object",
    properties: {
        productIdA: { type: "integer", description: "First product id of the candidate pair" },
        productIdB: { type: "integer", description: "Second product id of the candidate pair" },
    },
    required: ["productIdA", "productIdB"],
};

export const ShopsWatchAddInput = z.object({
    url: z.url(),
    target_price: z.number().nonnegative().optional(),
    drop_percent: z.number().min(0).max(1).optional(),
    drop_absolute: z.number().nonnegative().optional(),
    restricted_to_shop: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    cooldown_hours: z.number().int().min(1).max(720).optional(),
});
export type ShopsWatchAddInputT = z.infer<typeof ShopsWatchAddInput>;
export const ShopsWatchAddInputJsonSchema: JsonSchema = {
    type: "object",
    properties: {
        url: { type: "string", description: "Product URL to watch" },
        target_price: { type: "number", description: "Fire when current_price <= target_price" },
        drop_percent: {
            type: "number",
            description: "Fire when current_price falls by this fraction (0-1) vs reference_price",
            minimum: 0,
            maximum: 1,
        },
        drop_absolute: {
            type: "number",
            description: "Fire when reference_price - current_price >= this amount",
        },
        restricted_to_shop: { type: "string", description: "Only fire if a price hits inside this shop" },
        label: { type: "string", description: "User label for the watch entry" },
        cooldown_hours: {
            type: "integer",
            description: "Min hours between alerts (default 24)",
            minimum: 1,
            maximum: 720,
        },
    },
    required: ["url"],
};

export const ShopsWatchRemoveInput = z.object({
    id: z.number().int().positive(),
});
export type ShopsWatchRemoveInputT = z.infer<typeof ShopsWatchRemoveInput>;
export const ShopsWatchRemoveInputJsonSchema: JsonSchema = {
    type: "object",
    properties: { id: { type: "integer", description: "Favorite row id to remove" } },
    required: ["id"],
};

export const ShopsNotifyAckInput = z.object({
    id: z.number().int().positive(),
});
export type ShopsNotifyAckInputT = z.infer<typeof ShopsNotifyAckInput>;
export const ShopsNotifyAckInputJsonSchema: JsonSchema = {
    type: "object",
    properties: { id: { type: "integer", description: "Notification row id to acknowledge" } },
    required: ["id"],
};
