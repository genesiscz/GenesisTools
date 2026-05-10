import logger from "@app/logger";
import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { SearchHit, SearchResponse } from "@app/shops/types";
import { apiHandler, intParam, parseQuery } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

const log = logger.child({ component: "api:search" });

interface SearchQuery {
    q: string;
    limit: number;
}

// Hand-built DTO — the SELECT mixes products / master_products columns via CASE.
// FTS5 MATCH and the products_fts.rank pseudo-column are unmodeled by Kysely;
// see ProductsFtsTable in src/shops/db/types.ts.
interface SearchRow {
    type: "master" | "product";
    id: number;
    name: string;
    brand: string | null;
    image_url: string | null;
    shop_origin: string | null;
    slug: string | null;
    rank: number;
    best_price: number | null;
    total_offers: number | null;
    best_price_shop: string | null;
}

export const Route = createFileRoute("/api/search")({
    server: {
        handlers: {
            GET: apiHandler(async (request) => {
                const parsed = parseQuery<SearchQuery>(request, (p) => {
                    try {
                        const q = (p.get("q") ?? "").trim();
                        if (q.length < 2) {
                            return new Error("q must be at least 2 characters");
                        }

                        return {
                            q,
                            limit: intParam(p, "limit", 20, { min: 1, max: 100 }),
                        };
                    } catch (err) {
                        return err as Error;
                    }
                });

                if (parsed instanceof Response) {
                    return parsed;
                }

                const db = getShopsDatabase().raw();

                const ftsQuery = parsed.q
                    .split(/\s+/)
                    .filter((t) => t.length > 0)
                    .map((t, i, arr) => {
                        const safe = t.replace(/"/g, '""');
                        return i === arr.length - 1 ? `"${safe}"*` : `"${safe}"`;
                    })
                    .join(" ");

                const rows = db
                    .query<SearchRow, [string, number]>(
                        `SELECT
                            CASE WHEN p.master_product_id IS NOT NULL THEN 'master' ELSE 'product' END AS type,
                            CASE WHEN p.master_product_id IS NOT NULL THEN m.id ELSE p.id END AS id,
                            CASE WHEN p.master_product_id IS NOT NULL THEN m.canonical_name ELSE p.name END AS name,
                            COALESCE(m.brand, p.brand) AS brand,
                            COALESCE(m.representative_image_url, p.image_url) AS image_url,
                            CASE WHEN p.master_product_id IS NULL THEN p.shop_origin ELSE NULL END AS shop_origin,
                            CASE WHEN p.master_product_id IS NULL THEN p.slug ELSE NULL END AS slug,
                            products_fts.rank AS rank,
                            m.best_price AS best_price,
                            CASE WHEN p.master_product_id IS NOT NULL THEN m.total_offers ELSE NULL END AS total_offers,
                            CASE WHEN p.master_product_id IS NOT NULL THEN m.best_price_shop ELSE NULL END AS best_price_shop
                         FROM products_fts
                         JOIN products p ON p.id = products_fts.rowid
                         LEFT JOIN master_products m ON m.id = p.master_product_id
                         WHERE products_fts MATCH ?
                         ORDER BY products_fts.rank
                         LIMIT ?`
                    )
                    .all(ftsQuery, parsed.limit);

                const dedup = new Map<string, SearchHit>();
                for (const r of rows) {
                    const key = `${r.type}:${r.id}`;
                    const existing = dedup.get(key);
                    if (!existing || existing.rank > r.rank) {
                        dedup.set(key, r as SearchHit);
                    }
                }

                log.debug({ q: parsed.q, hits: dedup.size }, "api: search served");
                const body: SearchResponse = {
                    hits: Array.from(dedup.values()).slice(0, parsed.limit),
                    query: parsed.q,
                    limit: parsed.limit,
                };
                return Response.json(body);
            }),
        },
    },
});
