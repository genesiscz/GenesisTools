import type { Selectable } from "kysely";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { Product, ProductsTable } from "@app/shops/db/types";

export interface SearchOptions {
    limit?: number;
    shopOrigin?: string;
}

// FTS5 MATCH unmodeled by Kysely; SELECT p.* maps onto Selectable<ProductsTable>.
type FtsRow = Selectable<ProductsTable>;

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

        const params: (string | number)[] = opts.shopOrigin ? [ftsQuery, opts.shopOrigin, limit] : [ftsQuery, limit];

        const rows = this.db
            .raw()
            .query<FtsRow, (string | number)[]>(sql)
            .all(...params);
        return rows;
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
