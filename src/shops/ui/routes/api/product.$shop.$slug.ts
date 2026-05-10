import logger from "@app/logger";
import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { apiHandler } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

const log = logger.child({ component: "api:product:$shop:$slug" });

export const Route = createFileRoute("/api/product/$shop/$slug")({
    server: {
        handlers: {
            GET: apiHandler(async (request) => {
                const url = new URL(request.url);
                const segments = url.pathname.split("/");
                const slug = decodeURIComponent(segments.at(-1) ?? "");
                const shop = decodeURIComponent(segments.at(-2) ?? "");
                if (!shop || !slug) {
                    return Response.json({ error: "shop and slug required" }, { status: 400 });
                }

                const product = await getShopsDatabase()
                    .kysely()
                    .selectFrom("products")
                    .select(["master_product_id", "name", "url"])
                    .where("shop_origin", "=", shop)
                    .where("slug", "=", slug)
                    .executeTakeFirst();

                if (!product) {
                    return Response.json({ error: "Product not found" }, { status: 404 });
                }

                log.debug({ shop, slug, master: product.master_product_id }, "api: product lookup");
                return Response.json(product);
            }),
        },
    },
});
