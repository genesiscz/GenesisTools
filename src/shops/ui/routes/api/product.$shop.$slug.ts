import logger from "@app/logger";
import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";

const log = logger.child({ component: "api:product:$shop:$slug" });

interface ProductRow {
    master_product_id: number | null;
    name: string;
    url: string;
}

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

                const db = getShopsDatabase().raw();
                const product = db
                    .query<ProductRow, [string, string]>(
                        `SELECT master_product_id, name, url FROM products WHERE shop_origin = ? AND slug = ?`
                    )
                    .get(shop, slug);

                if (!product) {
                    return Response.json({ error: "Product not found" }, { status: 404 });
                }

                log.debug({ shop, slug, master: product.master_product_id }, "api: product lookup");
                return Response.json(product);
            }),
        },
    },
});
