import type { ShopsDatabase } from "./ShopsDatabase";
import type { Product } from "./types";

export interface SearchOptions {
    limit?: number;
    shopOrigin?: string;
}

interface FtsRow {
    id: number;
    shop_origin: string;
    slug: string;
    url: string;
    name: string;
    name_normalized: string;
    brand: string | null;
    brand_normalized: string | null;
    ean: string | null;
    image_url: string | null;
    unit: string | null;
    unit_amount: number | null;
    pack_count: number | null;
    flavor_key: string | null;
    master_product_id: number | null;
    match_method: string;
    match_similarity: number | null;
    match_at: string | null;
    first_seen_at: string;
    last_updated_at: string;
    is_active: number;
    metadata_json: string;
}

export class SearchRepository {
    constructor(private readonly db: ShopsDatabase) {}

    /**
     * Search products via FTS5 virtual table. Diacritic-insensitive (tokenizer
     * `unicode61 remove_diacritics 2`). Pass a query string in FTS5 syntax,
     * or plain words — the implementation prefix-matches each token.
     */
    search(query: string, opts: SearchOptions = {}): Product[] {
        const limit = opts.limit ?? 50;
        const ftsQuery = toPrefixQuery(query);
        if (!ftsQuery) {
            return [];
        }

        const sql = opts.shopOrigin
            ? `SELECT p.* FROM products p
               JOIN products_fts fts ON fts.rowid = p.id
               WHERE products_fts MATCH ? AND p.shop_origin = ? AND p.is_active = 1
               ORDER BY rank
               LIMIT ?`
            : `SELECT p.* FROM products p
               JOIN products_fts fts ON fts.rowid = p.id
               WHERE products_fts MATCH ? AND p.is_active = 1
               ORDER BY rank
               LIMIT ?`;

        const params: (string | number)[] = opts.shopOrigin
            ? [ftsQuery, opts.shopOrigin, limit]
            : [ftsQuery, limit];

        const rows = this.db.raw().query<FtsRow, (string | number)[]>(sql).all(...params);
        return rows as Product[];
    }
}

function toPrefixQuery(input: string): string {
    const cleaned = input.trim().replace(/[^\p{L}\p{N}\s]+/gu, " ");
    const tokens = cleaned.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
        return "";
    }

    return tokens.map((t) => `${t}*`).join(" ");
}
