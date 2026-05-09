import logger from "@app/logger";
import type { ShopApiClient } from "../api/ShopApiClient";
import { ShopRegistry } from "../api/ShopRegistry";
import { getShopsDatabase, type ShopsDatabase } from "../db/ShopsDatabase";

const log = logger.child({ component: "sync-shops-from-registry" });

/**
 * Push the registered ShopClients' display name + capabilities + bot
 * protection into the `shops` table. Without this the table holds whatever
 * defaults were written at first ingest (cap_live=0, cap_listing=0, …) and
 * the dashboard's /coverage capability badges go stale.
 *
 * Idempotent. Safe to call multiple times — used by initShopRegistry().
 */
export async function syncShopsFromRegistry(db: ShopsDatabase = getShopsDatabase()): Promise<void> {
    const registry = ShopRegistry.get();
    const clients = registry.all();
    if (clients.length === 0) {
        log.debug("registry empty — skip sync");
        return;
    }

    for (const client of clients) {
        await upsertFromClient(db, client);
    }

    log.debug({ shops: clients.length }, "shops synced from registry");
}

async function upsertFromClient(db: ShopsDatabase, client: ShopApiClient): Promise<void> {
    await db.upsertShop({
        origin: client.shopOrigin,
        display_name: client.displayName,
        currency: client.currency,
        cap_live: client.capabilities.live ? 1 : 0,
        cap_history: client.capabilities.history ? 1 : 0,
        cap_listing: client.capabilities.listing ? 1 : 0,
        cap_ean: client.capabilities.ean ? 1 : 0,
        cap_search: client.capabilities.search ? 1 : 0,
        bot_protection: client.capabilities.botProtection,
    });
}
