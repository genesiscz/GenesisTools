import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { UserOrdersRepository } from "@app/shops/db/UserOrdersRepository";
import { UserProvidersRepository } from "@app/shops/db/UserProvidersRepository";
import { apiHandler, intParam, parseQuery } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

interface OrderItemOut {
    line_no: number;
    name: string;
    external_product_id: string | null;
    quantity: number | null;
    unit_price: number | null;
    total_price: number | null;
    master_product_id: number | null;
    product_id: number | null;
}

interface OrderOut {
    id: number;
    external_order_id: string;
    ordered_at: string;
    total_amount: number;
    currency: string;
    items_count: number;
    items: OrderItemOut[];
}

interface ProviderOrders {
    shop_origin: string;
    orders: OrderOut[];
}

export const Route = createFileRoute("/api/orders/list")({
    server: {
        handlers: {
            GET: apiHandler(async (request) => {
                const params = parseQuery(request, (p) => ({
                    shop: p.get("shop"),
                    limit: intParam(p, "limit", 20, { min: 1, max: 100 }),
                    offset: intParam(p, "offset", 0, { min: 0 }),
                }));
                if (params instanceof Response) {
                    return params;
                }

                const db = getShopsDatabase();
                const providers = new UserProvidersRepository(db);
                const orders = new UserOrdersRepository(db);
                const all = await providers.listForUser(1);
                const targets = all.filter((p) => !params.shop || p.shop_origin === params.shop);

                const out: ProviderOrders[] = [];
                for (const provider of targets) {
                    const list = await orders.listForUserProvider(provider.id, params.limit, params.offset);
                    const detailed: OrderOut[] = [];
                    for (const o of list) {
                        const detail = await orders.getOrderWithItems(o.id);
                        if (detail) {
                            detailed.push({
                                id: detail.id,
                                external_order_id: detail.external_order_id,
                                ordered_at: detail.ordered_at,
                                total_amount: detail.total_amount,
                                currency: detail.currency,
                                items_count: detail.items_count,
                                items: detail.items.map((it) => ({
                                    line_no: it.line_no,
                                    name: it.name,
                                    external_product_id: it.external_product_id,
                                    quantity: it.quantity,
                                    unit_price: it.unit_price,
                                    total_price: it.total_price,
                                    master_product_id: it.master_product_id,
                                    product_id: it.product_id,
                                })),
                            });
                        }
                    }

                    out.push({ shop_origin: provider.shop_origin, orders: detailed });
                }

                return Response.json(out);
            }),
        },
    },
});
