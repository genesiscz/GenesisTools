import logger from "@app/logger";
import { SafeJSON } from "@app/utils/json";
// @ts-expect-error -- @hlidac-shopu/lib ships ESM with no .d.ts coverage
import { parseItemDetails } from "@hlidac-shopu/lib/shops.mjs";
import { getShopsDatabase, type ShopsDatabase } from "@app/shops/db/ShopsDatabase";

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

const PRODUCT_SELECT = `
    SELECT p.id, p.shop_origin, p.slug, p.url, p.name, p.brand, p.ean, p.image_url, p.unit, p.unit_amount, p.master_product_id,
           co.current_price, co.original_price, co.in_stock, co.price_observed_at
    FROM products p
    LEFT JOIN current_offers co ON co.product_id = p.id
`;

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

function findProductBy(shopsDb: ShopsDatabase, where: { shop?: string; slug?: string }): ProductRow | null {
    if (where.shop !== undefined && where.slug !== undefined) {
        const row = shopsDb
            .raw()
            .query<ProductRow, [string, string]>(`${PRODUCT_SELECT} WHERE p.shop_origin = ? AND p.slug = ?`)
            .get(where.shop, where.slug);
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

        row = findProductBy(shopsDb, { shop: parsed.origin, slug: parsed.itemId });
    } else if (input.shop && input.slug) {
        row = findProductBy(shopsDb, { shop: input.shop, slug: input.slug });
    } else {
        throw new Error("getProduct requires {url} or {shop, slug}");
    }

    if (!row) {
        throw new Error(`Product not found: ${SafeJSON.stringify(input)}`);
    }

    const history = shopsDb
        .raw()
        .query<
            {
                observed_at: string;
                current_price: number | null;
                original_price: number | null;
                in_stock: number | null;
            },
            [number]
        >(
            `SELECT observed_at, current_price, original_price, in_stock
             FROM prices WHERE product_id = ? ORDER BY observed_at ASC`
        )
        .all(row.id);

    const matches =
        row.master_product_id === null
            ? []
            : shopsDb
                  .raw()
                  .query<ProductRow, [number, number]>(
                      `${PRODUCT_SELECT} WHERE p.master_product_id = ? AND p.id <> ? ORDER BY p.shop_origin ASC`
                  )
                  .all(row.master_product_id, row.id);

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
    return shopsDb
        .raw()
        .query<{ id: string; name: string; parent_id: string | null }, [string]>(
            "SELECT id, name, parent_id FROM categories WHERE shop_origin = ? ORDER BY id"
        )
        .all(input.shop);
}

export async function comparePrices(
    input: { masterIds: number[] },
    ctx?: ProductApiContext
): Promise<Array<{ master_id: number; offers: ProductDTO[]; history_points: number }>> {
    const shopsDb = db(ctx);
    const out: Array<{ master_id: number; offers: ProductDTO[]; history_points: number }> = [];
    for (const masterId of input.masterIds) {
        const offers = shopsDb
            .raw()
            .query<ProductRow, [number]>(`${PRODUCT_SELECT} WHERE p.master_product_id = ? ORDER BY p.shop_origin`)
            .all(masterId);
        const counts =
            shopsDb
                .raw()
                .query<{ n: number }, [number]>(
                    `SELECT COUNT(*) AS n FROM prices p JOIN products pr ON pr.id = p.product_id WHERE pr.master_product_id = ?`
                )
                .get(masterId)?.n ?? 0;
        out.push({
            master_id: masterId,
            offers: offers.map(rowToDto),
            history_points: counts,
        });
    }

    return out;
}

export async function getMaster(
    input: { id: number },
    ctx?: ProductApiContext
): Promise<{ master_id: number; canonical_name: string | null; offers: ProductDTO[] }> {
    const shopsDb = db(ctx);
    const master = shopsDb
        .raw()
        .query<{ id: number; canonical_name: string | null }, [number]>(
            "SELECT id, canonical_name FROM master_products WHERE id = ?"
        )
        .get(input.id);
    if (!master) {
        throw new Error(`Master not found: ${input.id}`);
    }

    const offers = shopsDb
        .raw()
        .query<ProductRow, [number]>(`${PRODUCT_SELECT} WHERE p.master_product_id = ? ORDER BY p.shop_origin`)
        .all(input.id);
    return {
        master_id: master.id,
        canonical_name: master.canonical_name,
        offers: offers.map(rowToDto),
    };
}
