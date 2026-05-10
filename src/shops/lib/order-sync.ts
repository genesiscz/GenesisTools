import logger from "@app/logger";
import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { UserOrdersRepository } from "@app/shops/db/UserOrdersRepository";
import { UserProvidersRepository } from "@app/shops/db/UserProvidersRepository";
import { addFavoriteByMaster } from "@app/shops/lib/watchlist-api";
import { SafeJSON } from "@app/utils/json";
import { nowUtcIso } from "@app/utils/sql-time";

const log = logger.child({ component: "shops:order-sync" });

export interface NormalizedOrder {
    external_order_id: string;
    ordered_at: string;
    total_amount: number;
    currency: string;
    items_count: number;
    state: string | null;
}

export interface NormalizedOrderItem {
    line_no: number;
    external_product_id: string;
    name: string;
    quantity: number | null;
    unit: string | null;
    unit_price: number | null;
    total_price: number | null;
}

export interface NormalizedOrderDetail {
    external_order_id: string;
    raw_json: string;
    items: NormalizedOrderItem[];
}

export interface SyncAuthClient {
    kind: "rohlik" | "kosik";
    getProfile(): Promise<{ email: string }>;
    listOrders(opts: { limit: number; offset: number }): Promise<NormalizedOrder[]>;
    getOrderDetail(externalId: string): Promise<NormalizedOrderDetail>;
}

export type AuthClientFactory = (args: {
    shopOrigin: string;
    credentials: unknown;
}) => Promise<SyncAuthClient> | SyncAuthClient;

export interface SyncProviderArgs {
    userProviderId: number;
    factory: AuthClientFactory;
    enableAutoWatchlist?: boolean;
    limit?: number;
    signal?: AbortSignal;
}

export interface SyncProviderResult {
    shop_origin: string;
    orders_new: number;
    items_new: number;
    items_matched: number;
    auto_added: number;
}

export async function syncProvider(args: SyncProviderArgs): Promise<SyncProviderResult> {
    const db = getShopsDatabase();
    const providers = new UserProvidersRepository(db);
    const orders = new UserOrdersRepository(db);
    const provider = await providers.getById(args.userProviderId);
    if (!provider) {
        throw new Error(`user_provider ${args.userProviderId} not found`);
    }

    const credentials = await providers.getCredentials(provider.id);
    let client: SyncAuthClient;
    try {
        client = await args.factory({ shopOrigin: provider.shop_origin, credentials });
        await client.getProfile();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await providers.setStatus(provider.id, "expired", msg);
        throw err;
    }

    const list = await client.listOrders({ limit: args.limit ?? 50, offset: 0 });
    const known = await orders.listExternalIds(provider.id);
    const fresh = list.filter((o) => !known.has(o.external_order_id));

    let ordersNew = 0;
    let itemsNew = 0;
    let itemsMatched = 0;
    let autoAdded = 0;

    const autoWatchlist = args.enableAutoWatchlist ?? provider.auto_watchlist === 1;
    const watchlistDefaults = SafeJSON.parse(provider.watchlist_defaults_json ?? "{}") as {
        drop_percent?: number;
        cooldown_hours?: number;
        notify_back_in_stock?: boolean;
    };

    for (const order of fresh) {
        args.signal?.throwIfAborted();
        const detail = await client.getOrderDetail(order.external_order_id);
        const orderId = await orders.upsertOrder({
            user_provider_id: provider.id,
            external_order_id: order.external_order_id,
            ordered_at: order.ordered_at,
            total_amount: order.total_amount,
            currency: order.currency,
            items_count: order.items_count,
            state: order.state,
            raw_json: detail.raw_json,
        });
        ordersNew++;
        await orders.upsertOrderItems(orderId, detail.items);
        itemsNew += detail.items.length;

        for (const item of detail.items) {
            if (!item.external_product_id) {
                continue;
            }

            const productRow = db
                .raw()
                .query<
                    { id: number; master_product_id: number | null },
                    [string, string]
                >("SELECT id, master_product_id FROM products WHERE shop_origin = ? AND slug = ? LIMIT 1")
                .get(provider.shop_origin, item.external_product_id);
            if (productRow) {
                await orders.markItemMatched(
                    orderId,
                    item.line_no,
                    productRow.id,
                    productRow.master_product_id
                );
                if (productRow.master_product_id !== null) {
                    itemsMatched++;
                    if (autoWatchlist) {
                        try {
                            await addFavoriteByMaster({
                                master_product_id: productRow.master_product_id,
                                drop_percent: watchlistDefaults.drop_percent ?? 0.1,
                                cooldown_hours: watchlistDefaults.cooldown_hours ?? 24,
                                notify_back_in_stock: watchlistDefaults.notify_back_in_stock ?? false,
                            });
                            autoAdded++;
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            if (!msg.includes("UNIQUE")) {
                                throw err;
                            }
                        }
                    }
                }
            }
        }
    }

    await providers.setLastSync(provider.id, nowUtcIso());
    log.info(
        { providerId: provider.id, ordersNew, itemsNew, itemsMatched, autoAdded },
        "syncProvider completed"
    );
    return {
        shop_origin: provider.shop_origin,
        orders_new: ordersNew,
        items_new: itemsNew,
        items_matched: itemsMatched,
        auto_added: autoAdded,
    };
}
