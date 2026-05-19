import { logger } from "@app/logger";
import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { MasterDetail } from "@app/shops/types";
import { apiHandler } from "@app/shops/ui/server/api-utils";
import { SafeJSON } from "@app/utils/json";
import { createFileRoute } from "@tanstack/react-router";
import { sql } from "kysely";

const log = logger.child({ component: "api:master:$id" });

export const Route = createFileRoute("/api/master/$id")({
    server: {
        handlers: {
            GET: apiHandler(async (request) => {
                const url = new URL(request.url);
                const idStr = url.pathname.split("/").at(-1) ?? "";
                const id = Number(idStr);
                if (!Number.isInteger(id) || id <= 0) {
                    return Response.json({ error: `Invalid master id: ${idStr}` }, { status: 400 });
                }

                const k = getShopsDatabase().kysely();

                const master = await k
                    .selectFrom("master_products as mp")
                    .leftJoin("master_categories as mc", "mc.id", "mp.master_category_id")
                    .select([
                        "mp.id",
                        "mp.canonical_name",
                        "mp.canonical_slug",
                        "mp.brand",
                        "mp.brand_normalized",
                        "mp.ean",
                        "mp.representative_image_url",
                        "mp.total_offers",
                        "mp.best_price",
                        "mp.best_price_shop",
                        "mp.best_price_at",
                        "mp.master_category_id",
                        "mc.name as master_category_name",
                        "mp.unit",
                        "mp.unit_amount",
                        "mp.pack_count",
                        "mp.flavor_key",
                        "mp.attributes_json",
                    ])
                    .where("mp.id", "=", id)
                    .executeTakeFirst();

                if (!master) {
                    return Response.json({ error: `Master ${id} not found` }, { status: 404 });
                }

                const offers = await k
                    .selectFrom("current_offers as co")
                    .innerJoin("shops as s", "s.origin", "co.shop_origin")
                    .innerJoin("products as p", "p.id", "co.product_id")
                    .select([
                        "co.product_id",
                        "co.shop_origin",
                        "s.display_name as shop_display_name",
                        "co.name",
                        "co.url",
                        "co.image_url",
                        "co.current_price",
                        "co.original_price",
                        "co.in_stock",
                        "co.price_observed_at",
                        sql<number | null>`CASE
                            WHEN co.original_price IS NOT NULL AND co.original_price > 0 AND co.current_price IS NOT NULL
                            THEN ROUND((1.0 - co.current_price / co.original_price) * 100, 1)
                            ELSE NULL
                        END`.as("claimed_discount_percent"),
                        sql<number | null>`NULL`.as("real_discount_percent"),
                        "p.brand",
                        "p.ean",
                        "p.unit",
                        "p.unit_amount",
                        "p.pack_count",
                        "p.description",
                        "p.category_path",
                        "p.metadata_json",
                        "p.first_seen_at",
                        "p.last_updated_at",
                    ])
                    .where("co.master_product_id", "=", id)
                    .orderBy(sql`CASE WHEN co.current_price IS NULL THEN 1 ELSE 0 END`)
                    .orderBy("co.current_price", "asc")
                    .execute();

                let attributes: Record<string, unknown> = {};
                if (master.attributes_json) {
                    try {
                        attributes = SafeJSON.parse(master.attributes_json) as Record<string, unknown>;
                    } catch {
                        attributes = {};
                    }
                }

                const body: MasterDetail = {
                    id: master.id,
                    canonical_name: master.canonical_name,
                    canonical_slug: master.canonical_slug,
                    brand: master.brand,
                    brand_normalized: master.brand_normalized,
                    ean: master.ean,
                    representative_image_url: master.representative_image_url,
                    total_offers: master.total_offers,
                    best_price: master.best_price,
                    best_price_shop: master.best_price_shop,
                    best_price_at: master.best_price_at,
                    master_category_id: master.master_category_id,
                    master_category_name: master.master_category_name,
                    unit: master.unit,
                    unit_amount: master.unit_amount,
                    pack_count: master.pack_count,
                    flavor_key: master.flavor_key,
                    attributes_json: attributes,
                    offers,
                };

                log.debug({ id, offers: offers.length }, "api: master detail served");
                return Response.json(body);
            }),
        },
    },
});
