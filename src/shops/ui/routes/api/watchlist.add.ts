import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { addFavorite } from "@app/shops/lib/watchlist-api";
import { apiHandler, jsonBody } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/watchlist/add")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await jsonBody(request);
                if (body instanceof Response) {
                    return body;
                }

                // Resolve `url` directly OR by master_product_id — StarWatchButton
                // on the master detail page only knows the master id.
                let url: string | null = typeof body.url === "string" && body.url.length > 0 ? body.url : null;
                if (!url && typeof body.master_product_id === "number") {
                    const row = await getShopsDatabase()
                        .kysely()
                        .selectFrom("products")
                        .select("url")
                        .where("master_product_id", "=", body.master_product_id)
                        .where("is_active", "=", 1)
                        .orderBy("id")
                        .limit(1)
                        .executeTakeFirst();
                    if (row) {
                        url = row.url;
                    }
                }

                if (!url) {
                    return Response.json({ error: "Field 'url' or 'master_product_id' is required" }, { status: 400 });
                }

                const result = await addFavorite({
                    url,
                    target_price: typeof body.target_price === "number" ? body.target_price : null,
                    drop_percent: typeof body.drop_percent === "number" ? body.drop_percent : null,
                    drop_absolute: typeof body.drop_absolute === "number" ? body.drop_absolute : null,
                    restricted_to_shop: typeof body.restricted_to_shop === "string" ? body.restricted_to_shop : null,
                    label: typeof body.label === "string" ? body.label : null,
                    cooldown_hours: typeof body.cooldown_hours === "number" ? body.cooldown_hours : 24,
                    notify_back_in_stock: body.notify_back_in_stock === true,
                });
                return Response.json(result);
            }),
        },
    },
});
