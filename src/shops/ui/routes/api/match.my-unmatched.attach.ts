import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { authedApiHandler, jsonBody } from "@app/shops/ui/server/api-utils";
import { nowUtcIso } from "@app/utils/sql-time";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/match/my-unmatched/attach")({
    server: {
        handlers: {
            POST: authedApiHandler(async (request, userId) => {
                const body = await jsonBody(request);
                if (body instanceof Response) {
                    return body;
                }

                const orderId = typeof body.order_id === "number" ? body.order_id : null;
                const lineNo = typeof body.line_no === "number" ? body.line_no : null;
                const masterId = typeof body.master_product_id === "number" ? body.master_product_id : null;
                if (orderId === null || lineNo === null || masterId === null) {
                    return Response.json({ error: "order_id, line_no, master_product_id required" }, { status: 400 });
                }

                const db = getShopsDatabase();
                // Verify the order belongs to this user.
                const owner = await db
                    .kysely()
                    .selectFrom("user_orders as uo")
                    .innerJoin("user_providers as up", "up.id", "uo.user_provider_id")
                    .where("uo.id", "=", orderId)
                    .where("up.user_id", "=", userId)
                    .select("uo.id")
                    .executeTakeFirst();
                if (!owner) {
                    return Response.json({ error: "order not found for user" }, { status: 404 });
                }

                await db
                    .kysely()
                    .updateTable("user_order_items")
                    .set({
                        master_product_id: masterId,
                        matched_at: nowUtcIso(),
                    })
                    .where("order_id", "=", orderId)
                    .where("line_no", "=", lineNo)
                    .execute();
                return Response.json({ ok: true });
            }),
        },
    },
});
