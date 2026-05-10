import logger from "@app/logger";
import { getShopsDatabase, type ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { CurrentOffersView, ProductsTable } from "@app/shops/db/types";
import type { ProductDTO } from "@app/shops/lib/product-api";
import type { Selectable } from "kysely";

const log = logger.child({ component: "shops:search-api" });

export interface SearchApiContext {
    shopsDb?: ShopsDatabase;
}

export interface SearchProductsInput {
    query: string;
    shop?: string;
    category?: string;
    limit?: number;
}

// FTS5 MATCH is unmodeled by Kysely — query stays raw. Row shape is anchored on
// ProductsTable + CurrentOffersView so the projection list and the row type
// share a single source of truth.
type ProductRow = Pick<
    Selectable<ProductsTable>,
    | "id"
    | "shop_origin"
    | "slug"
    | "url"
    | "name"
    | "brand"
    | "ean"
    | "image_url"
    | "unit"
    | "unit_amount"
    | "master_product_id"
> &
    Pick<CurrentOffersView, "current_price" | "original_price" | "in_stock"> & {
        // LEFT JOIN can produce NULL even though current_offers.price_observed_at is NOT NULL in the view.
        price_observed_at: string | null;
    };

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

function buildFtsQuery(input: string): string {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
        throw new Error("searchProducts: query must be a non-empty string");
    }

    const tokens = trimmed
        .split(/\s+/)
        .map((t) => t.replace(/"/g, ""))
        .filter((t) => t.length > 0);
    if (tokens.length === 0) {
        throw new Error("searchProducts: query must be a non-empty string");
    }

    return tokens.map((t) => `"${t}"*`).join(" ");
}

export async function searchProducts(input: SearchProductsInput, ctx?: SearchApiContext): Promise<ProductDTO[]> {
    const shopsDb = ctx?.shopsDb ?? getShopsDatabase();
    const ftsQuery = buildFtsQuery(input.query);
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 200);

    const where: string[] = ["products_fts MATCH ?"];
    const params: Array<string | number> = [ftsQuery];
    if (input.shop) {
        where.push("p.shop_origin = ?");
        params.push(input.shop);
    }

    if (input.category) {
        where.push("EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id = p.id AND pc.category_id = ?)");
        params.push(input.category);
    }

    params.push(limit);

    const sql = `
        SELECT p.id, p.shop_origin, p.slug, p.url, p.name, p.brand, p.ean, p.image_url, p.unit, p.unit_amount, p.master_product_id,
               co.current_price, co.original_price, co.in_stock, co.price_observed_at
        FROM products_fts
        JOIN products p ON p.id = products_fts.rowid
        LEFT JOIN current_offers co ON co.product_id = p.id
        WHERE ${where.join(" AND ")}
        ORDER BY rank
        LIMIT ?
    `;

    const rows = shopsDb
        .raw()
        .query<ProductRow, typeof params>(sql)
        .all(...params);
    log.debug({ query: input.query, count: rows.length }, "searchProducts done");
    return rows.map(rowToDto);
}
