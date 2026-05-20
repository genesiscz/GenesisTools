import { logger } from "@app/logger";
import { getShopsDatabase, type ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { SafeJSON } from "@app/utils/json";
// @ts-expect-error -- @hlidac-shopu/lib ships ESM with no .d.ts coverage
import { parseItemDetails } from "@hlidac-shopu/lib/shops.mjs";

const log = logger.child({ component: "shops:product-api" });

export interface ProductApiContext {
    shopsDb?: ShopsDatabase;
}

export interface GetProductInput {
    url?: string;
    shop?: string;
    slug?: string;
}

export interface ProductDTO {
    id: number;
    shop_origin: string;
    slug: string;
    url: string;
    name: string;
    brand: string | null;
    ean: string | null;
    image_url: string | null;
    unit: string | null;
    unit_amount: number | null;
    master_product_id: number | null;
    current_price: number | null;
    original_price: number | null;
    in_stock: boolean | null;
    price_observed_at: string | null;
}

export interface PriceHistoryPoint {
    observed_at: string;
    current_price: number | null;
    original_price: number | null;
    in_stock: boolean | null;
}

export interface CrossShopMatch {
    product: ProductDTO;
    similarity: number;
    method: string;
}

export interface GetProductResult {
    product: ProductDTO;
    history: PriceHistoryPoint[];
    cross_shop_matches: CrossShopMatch[];
}

interface ProductRow {
    id: number;
    shop_origin: string;
    slug: string;
    url: string;
    name: string;
    brand: string | null;
    ean: string | null;
    image_url: string | null;
    unit: string | null;
    unit_amount: number | null;
    master_product_id: number | null;
    current_price: number | null;
    original_price: number | null;
    in_stock: number | null;
    price_observed_at: string | null;
}

interface ParseItemDetailsResult {
    origin?: string;
    itemId?: string;
    itemUrl?: string;
}

function selectProductWithOffer(shopsDb: ShopsDatabase) {
    return shopsDb
        .kysely()
        .selectFrom("products as p")
        .leftJoin("current_offers as co", "co.product_id", "p.id")
        .select([
            "p.id",
            "p.shop_origin",
            "p.slug",
            "p.url",
            "p.name",
            "p.brand",
            "p.ean",
            "p.image_url",
            "p.unit",
            "p.unit_amount",
            "p.master_product_id",
            "co.current_price",
            "co.original_price",
            "co.in_stock",
            "co.price_observed_at",
        ]);
}

function rowToDto(row: ProductRow): ProductDTO {
    return {
        id: row.id,
        shop_origin: row.shop_origin,
        slug: row.slug,
        url: row.url,
        name: row.name,
        brand: row.brand,
        ean: row.ean,
        image_url: row.image_url,
        unit: row.unit,
        unit_amount: row.unit_amount,
        master_product_id: row.master_product_id,
        current_price: row.current_price,
        original_price: row.original_price,
        in_stock: row.in_stock === null ? null : row.in_stock === 1,
        price_observed_at: row.price_observed_at,
    };
}

function db(ctx: ProductApiContext | undefined): ShopsDatabase {
    return ctx?.shopsDb ?? getShopsDatabase();
}

async function findProductBy(
    shopsDb: ShopsDatabase,
    where: { shop?: string; slug?: string }
): Promise<ProductRow | null> {
    if (where.shop !== undefined && where.slug !== undefined) {
        const row = await selectProductWithOffer(shopsDb)
            .where("p.shop_origin", "=", where.shop)
            .where("p.slug", "=", where.slug)
            .executeTakeFirst();
        return row ?? null;
    }

    return null;
}

export async function getProduct(input: GetProductInput, ctx?: ProductApiContext): Promise<GetProductResult> {
    const shopsDb = db(ctx);
    let row: ProductRow | null = null;
    if (input.url) {
        const parsed = parseItemDetails(input.url) as ParseItemDetailsResult | null;
        if (!parsed?.origin || !parsed.itemId) {
            throw new Error(`Cannot parse shop+slug from url: ${input.url}`);
        }

        row = await findProductBy(shopsDb, { shop: parsed.origin, slug: parsed.itemId });
    } else if (input.shop && input.slug) {
        row = await findProductBy(shopsDb, { shop: input.shop, slug: input.slug });
    } else {
        throw new Error("getProduct requires {url} or {shop, slug}");
    }

    if (!row) {
        throw new Error(`Product not found: ${SafeJSON.stringify(input)}`);
    }

    const history = await shopsDb
        .kysely()
        .selectFrom("prices")
        .select(["observed_at", "current_price", "original_price", "in_stock"])
        .where("product_id", "=", row.id)
        .orderBy("observed_at", "asc")
        .execute();

    const matches =
        row.master_product_id === null
            ? []
            : await selectProductWithOffer(shopsDb)
                  .where("p.master_product_id", "=", row.master_product_id)
                  .where("p.id", "!=", row.id)
                  .orderBy("p.shop_origin", "asc")
                  .execute();

    log.debug({ productId: row.id, masterId: row.master_product_id }, "getProduct done");

    return {
        product: rowToDto(row),
        history: history.map((h) => ({
            observed_at: h.observed_at,
            current_price: h.current_price,
            original_price: h.original_price,
            in_stock: h.in_stock === null ? null : h.in_stock === 1,
        })),
        cross_shop_matches: matches.map((m) => ({
            product: rowToDto(m),
            similarity: 1.0,
            method: "linked",
        })),
    };
}

export async function matchProduct(input: { url: string }, ctx?: ProductApiContext): Promise<CrossShopMatch[]> {
    const result = await getProduct({ url: input.url }, ctx);
    return result.cross_shop_matches;
}

export async function listCategories(
    input: { shop: string },
    ctx?: ProductApiContext
): Promise<Array<{ id: string; name: string; parent_id: string | null }>> {
    const shopsDb = db(ctx);
    return await shopsDb
        .kysely()
        .selectFrom("categories")
        .select(["id", "name", "parent_id"])
        .where("shop_origin", "=", input.shop)
        .orderBy("id")
        .execute();
}

export async function comparePrices(
    input: { masterIds: number[] },
    ctx?: ProductApiContext
): Promise<Array<{ master_id: number; offers: ProductDTO[]; history_points: number }>> {
    const shopsDb = db(ctx);
    const out: Array<{ master_id: number; offers: ProductDTO[]; history_points: number }> = [];
    for (const masterId of input.masterIds) {
        const offers = await selectProductWithOffer(shopsDb)
            .where("p.master_product_id", "=", masterId)
            .orderBy("p.shop_origin")
            .execute();
        const totalRow = await shopsDb
            .kysely()
            .selectFrom("prices as p")
            .innerJoin("products as pr", "pr.id", "p.product_id")
            .select((eb) => eb.fn.countAll<number>().as("n"))
            .where("pr.master_product_id", "=", masterId)
            .executeTakeFirst();
        out.push({
            master_id: masterId,
            offers: offers.map(rowToDto),
            history_points: totalRow?.n ?? 0,
        });
    }

    return out;
}

export async function getMaster(
    input: { id: number },
    ctx?: ProductApiContext
): Promise<{ master_id: number; canonical_name: string | null; offers: ProductDTO[] }> {
    const shopsDb = db(ctx);
    const master = await shopsDb
        .kysely()
        .selectFrom("master_products")
        .select(["id", "canonical_name"])
        .where("id", "=", input.id)
        .executeTakeFirst();
    if (!master) {
        throw new Error(`Master not found: ${input.id}`);
    }

    const offers = await selectProductWithOffer(shopsDb)
        .where("p.master_product_id", "=", input.id)
        .orderBy("p.shop_origin")
        .execute();
    return {
        master_id: master.id,
        canonical_name: master.canonical_name,
        offers: offers.map(rowToDto),
    };
}
