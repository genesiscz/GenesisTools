import { KosikAuthClient } from "@app/shops/api/shops/KosikAuthClient";
import { RohlikAuthClient } from "@app/shops/api/shops/RohlikAuthClient";
import type { ProviderCredentials } from "@app/shops/db/UserProvidersRepository";
import type { AuthClientFactory, SyncAuthClient } from "@app/shops/lib/order-sync";
import { SafeJSON } from "@app/utils/json";

export const realAuthClientFactory: AuthClientFactory = async ({ shopOrigin, credentials }) => {
    const creds = credentials as ProviderCredentials;
    if (shopOrigin === "rohlik.cz") {
        if (creds.type !== "email-password") {
            throw new Error("rohlik requires email-password credentials");
        }

        const c = new RohlikAuthClient();
        await c.login(creds.email, creds.password);
        return rohlikAdapter(c);
    }

    if (shopOrigin === "kosik.cz") {
        if (creds.type !== "session-cookie") {
            throw new Error("kosik requires session-cookie credentials");
        }

        const c = new KosikAuthClient({ sessionCookie: creds.cookie });
        return kosikAdapter(c);
    }

    throw new Error(`unsupported shop_origin for sync: ${shopOrigin}`);
};

function rohlikAdapter(c: RohlikAuthClient): SyncAuthClient {
    return {
        kind: "rohlik",
        async getProfile() {
            const p = await c.getProfile();
            return { email: p.email };
        },
        async listOrders(opts) {
            const list = await c.listOrders(opts);
            return list.map((o) => ({
                external_order_id: String(o.id),
                ordered_at: o.orderTime,
                total_amount: o.priceComposition.total.amount,
                currency: o.priceComposition.total.currency,
                items_count: o.itemsCount,
                state: "delivered",
            }));
        },
        async getOrderDetail(externalId) {
            const d = await c.getOrderDetail(Number(externalId));
            return {
                external_order_id: String(d.id),
                raw_json: SafeJSON.stringify(d),
                items: d.items.map((it, idx) => ({
                    line_no: idx,
                    external_product_id: String(it.id),
                    name: it.name,
                    quantity: it.amount,
                    unit: it.unit,
                    unit_price: it.priceComposition.unit?.amount ?? null,
                    total_price: it.priceComposition.total.amount,
                })),
            };
        },
    };
}

function kosikAdapter(c: KosikAuthClient): SyncAuthClient {
    return {
        kind: "kosik",
        async getProfile() {
            const p = await c.getProfile();
            return { email: p.client.email };
        },
        async listOrders(opts) {
            const r = await c.listOrders(opts);
            return r.orders.map((o) => ({
                external_order_id: String(o.id),
                ordered_at: String(o.orderedAt ?? new Date().toISOString()),
                total_amount: typeof o.total === "number" ? o.total : 0,
                currency: "CZK",
                items_count: 0,
                state: typeof o.state === "string" ? o.state : null,
            }));
        },
        async getOrderDetail(externalId) {
            const d = await c.getOrderDetail(externalId);
            const items = (d.items ?? []).map((it, idx) => ({
                line_no: idx,
                external_product_id: String(it.id ?? it.productId ?? it.slug ?? ""),
                name: String(it.name ?? "(unknown)"),
                quantity: typeof it.quantity === "number" ? it.quantity : null,
                unit: typeof it.unit === "string" ? it.unit : null,
                unit_price: typeof it.unitPrice === "number" ? it.unitPrice : null,
                total_price: typeof it.totalPrice === "number" ? it.totalPrice : null,
            }));
            return {
                external_order_id: String(d.id ?? externalId),
                raw_json: SafeJSON.stringify(d),
                items,
            };
        },
    };
}
