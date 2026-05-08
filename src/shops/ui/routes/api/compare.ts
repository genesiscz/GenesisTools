import logger from "@app/logger";
import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { CompareResponse, MasterDetail, MasterOfferRow } from "@app/shops/types";
import { SafeJSON } from "@app/utils/json";
import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";

const log = logger.child({ component: "api:compare" });

interface MasterRow {
    id: number;
    canonical_name: string;
    canonical_slug: string;
    brand: string | null;
    brand_normalized: string | null;
    ean: string | null;
    representative_image_url: string | null;
    total_offers: number;
    best_price: number | null;
    best_price_shop: string | null;
    best_price_at: string | null;
    master_category_id: number | null;
    master_category_name: string | null;
    unit: string | null;
    unit_amount: number | null;
    pack_count: number | null;
    flavor_key: string | null;
    attributes_json: string | null;
}

export const Route = createFileRoute("/api/compare")({
    server: {
        handlers: {
            GET: apiHandler(async (request) => {
                const url = new URL(request.url);
                const idsParam = url.searchParams.get("ids");
                if (!idsParam) {
                    return Response.json({ error: "ids query param required" }, { status: 400 });
                }

                const requestedIds = idsParam
                    .split(",")
                    .map((s) => Number(s.trim()))
                    .filter((n) => Number.isInteger(n) && n > 0);

                if (requestedIds.length === 0) {
                    return Response.json({ error: "ids must be non-empty integer list" }, { status: 400 });
                }

                if (requestedIds.length > 5) {
                    return Response.json({ error: "max 5 items in compare" }, { status: 400 });
                }

                const db = getShopsDatabase().raw();
                const placeholders = requestedIds.map(() => "?").join(",");
                const masters = db
                    .query<MasterRow, number[]>(
                        `SELECT mp.id, mp.canonical_name, mp.canonical_slug, mp.brand, mp.brand_normalized,
                                mp.ean, mp.representative_image_url, mp.total_offers, mp.best_price,
                                mp.best_price_shop, mp.best_price_at, mp.master_category_id,
                                mc.name AS master_category_name,
                                mp.unit, mp.unit_amount, mp.pack_count, mp.flavor_key, mp.attributes_json
                         FROM master_products mp
                         LEFT JOIN master_categories mc ON mc.id = mp.master_category_id
                         WHERE mp.id IN (${placeholders})`
                    )
                    .all(...requestedIds);

                const items: MasterDetail[] = [];
                for (const id of requestedIds) {
                    const m = masters.find((x) => x.id === id);
                    if (!m) {
                        continue;
                    }

                    const offers = db
                        .query<MasterOfferRow, [number]>(
                            `SELECT
                                co.product_id, co.shop_origin,
                                s.display_name AS shop_display_name,
                                co.name, co.url, co.image_url, co.current_price, co.original_price,
                                co.in_stock, co.price_observed_at,
                                CASE WHEN co.original_price IS NOT NULL AND co.original_price > 0 AND co.current_price IS NOT NULL
                                     THEN ROUND((1.0 - co.current_price / co.original_price) * 100, 1)
                                     ELSE NULL END AS claimed_discount_percent,
                                NULL AS real_discount_percent
                             FROM current_offers co
                             JOIN shops s ON s.origin = co.shop_origin
                             WHERE co.master_product_id = ?
                             ORDER BY CASE WHEN co.current_price IS NULL THEN 1 ELSE 0 END, co.current_price ASC`
                        )
                        .all(id);

                    let attributes: Record<string, unknown> = {};
                    if (m.attributes_json) {
                        try {
                            attributes = SafeJSON.parse(m.attributes_json) as Record<string, unknown>;
                        } catch {
                            attributes = {};
                        }
                    }

                    items.push({ ...m, attributes_json: attributes, offers });
                }

                const body: CompareResponse = {
                    items,
                    requested_ids: requestedIds,
                };
                log.debug({ requested: requestedIds.length, returned: items.length }, "api: compare served");
                return Response.json(body);
            }),
        },
    },
});
