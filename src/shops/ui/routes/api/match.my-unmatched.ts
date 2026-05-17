import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { authedApiHandler } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/match/my-unmatched")({
    server: {
        handlers: {
            GET: authedApiHandler(async (_request, userId) => {
                const rows = await getShopsDatabase()
                    .kysely()
                    .selectFrom("user_order_items as uoi")
                    .innerJoin("user_orders as uo", "uo.id", "uoi.order_id")
                    .innerJoin("user_providers as up", "up.id", "uo.user_provider_id")
                    .where("up.user_id", "=", userId)
                    .where("uoi.master_product_id", "is", null)
                    .select([
                        "uoi.order_id as order_id",
                        "uoi.line_no as line_no",
                        "uoi.name as name",
                        "uoi.quantity as quantity",
                        "uoi.unit as unit",
                        "uoi.unit_price as unit_price",
                        "uoi.total_price as total_price",
                        "uoi.external_product_id as external_product_id",
                        "up.shop_origin as shop_origin",
                        "uo.ordered_at as ordered_at",
                    ])
                    .orderBy("uo.ordered_at", "desc")
                    .orderBy("uoi.line_no", "asc")
                    .limit(500)
                    .execute();
                return Response.json(rows);
            }),
        },
    },
});
