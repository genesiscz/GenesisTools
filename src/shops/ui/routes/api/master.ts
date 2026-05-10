import logger from "@app/logger";
import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { MasterListItem, MasterListResponse } from "@app/shops/types";
import { createFileRoute } from "@tanstack/react-router";
import { apiHandler, intParam, parseQuery } from "@app/shops/ui/server/api-utils";

const log = logger.child({ component: "api:master" });

interface MasterListQuery {
    limit: number;
    offset: number;
    brand: string | null;
    category_id: number | null;
    sort: "best_price" | "total_offers" | "name";
    order: "asc" | "desc";
}

const ALLOWED_SORTS = ["best_price", "total_offers", "name"] as const;
const ALLOWED_ORDERS = ["asc", "desc"] as const;

export const Route = createFileRoute("/api/master")({
    server: {
        handlers: {
            GET: apiHandler(async (request) => {
                const parsed = parseQuery<MasterListQuery>(request, (p) => {
                    try {
                        const sortRaw = p.get("sort") ?? "name";
                        if (!ALLOWED_SORTS.includes(sortRaw as (typeof ALLOWED_SORTS)[number])) {
                            return new Error(`sort must be one of ${ALLOWED_SORTS.join("|")}; got ${sortRaw}`);
                        }

                        const orderRaw = p.get("order") ?? "asc";
                        if (!ALLOWED_ORDERS.includes(orderRaw as (typeof ALLOWED_ORDERS)[number])) {
                            return new Error(`order must be ${ALLOWED_ORDERS.join("|")}; got ${orderRaw}`);
                        }

                        return {
                            limit: intParam(p, "limit", 50, { min: 1, max: 200 }),
                            offset: intParam(p, "offset", 0, { min: 0 }),
                            brand: p.get("brand"),
                            category_id: p.get("category_id") ? intParam(p, "category_id", 0, { min: 1 }) : null,
                            sort: sortRaw as MasterListQuery["sort"],
                            order: orderRaw as MasterListQuery["order"],
                        };
                    } catch (err) {
                        return err as Error;
                    }
                });

                if (parsed instanceof Response) {
                    return parsed;
                }

                const db = getShopsDatabase().raw();
                const conditions: string[] = [];
                const params: Array<string | number> = [];
                if (parsed.brand) {
                    conditions.push("brand = ?");
                    params.push(parsed.brand);
                }

                if (parsed.category_id !== null) {
                    conditions.push("master_category_id = ?");
                    params.push(parsed.category_id);
                }

                const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

                const sortColumn =
                    parsed.sort === "best_price"
                        ? "COALESCE(best_price, 9.999e15)"
                        : parsed.sort === "total_offers"
                          ? "total_offers"
                          : "canonical_name COLLATE NOCASE";

                const totalRow = db
                    .query<{ total: number }, typeof params>(
                        `SELECT COUNT(*) AS total FROM master_products ${whereClause}`
                    )
                    .get(...params);
                const total = totalRow?.total ?? 0;

                const items = db
                    .query<MasterListItem, [...typeof params, number, number]>(
                        `SELECT id, canonical_name, canonical_slug, brand, representative_image_url,
                                total_offers, best_price, best_price_shop, master_category_id
                         FROM master_products
                         ${whereClause}
                         ORDER BY ${sortColumn} ${parsed.order.toUpperCase()}
                         LIMIT ? OFFSET ?`
                    )
                    .all(...params, parsed.limit, parsed.offset);

                log.debug({ total, returned: items.length, query: parsed }, "api: master list served");
                const body: MasterListResponse = {
                    items,
                    total,
                    limit: parsed.limit,
                    offset: parsed.offset,
                };
                return Response.json(body);
            }),
        },
    },
});
