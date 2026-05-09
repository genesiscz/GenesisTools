import logger from "@app/logger";
// @ts-expect-error -- @hlidac-shopu/lib ships ESM with no .d.ts coverage
import { shopOrigin as deriveShopOrigin } from "@hlidac-shopu/lib/shops.mjs";
import { HlidacShopuClient } from "../api/HlidacShopuClient";
import {
    type AddFavoriteArgs,
    type EditFavoriteArgs,
    type Favorite,
    FavoritesRepository,
    type FavoriteWithState,
} from "../db/FavoritesRepository";
import { type Notification, type NotificationReason, NotificationsRepository } from "../db/NotificationsRepository";
import { getShopsDatabase } from "../db/ShopsDatabase";
import { ingestFromHlidacResult } from "./ingest";

const log = logger.child({ component: "shops:watchlist-api" });

export interface WatchInput {
    url: string;
    target_price?: number | null;
    drop_percent?: number | null;
    drop_absolute?: number | null;
    restricted_to_shop?: string | null;
    label?: string | null;
    cooldown_hours?: number;
    notify_back_in_stock?: boolean;
}

export interface AddFavoriteResult {
    favorite_id: number;
    master_product_id: number;
    auto_ingested: boolean;
}

function repos() {
    const db = getShopsDatabase();
    return {
        db,
        favorites: new FavoritesRepository(db),
        notifications: new NotificationsRepository(db),
    };
}

async function resolveProductByUrl(url: string): Promise<{
    masterId: number;
    productId: number;
    shopOrigin: string;
    autoIngested: boolean;
}> {
    const { db } = repos();
    const origin = deriveShopOrigin(url);
    if (!origin) {
        throw new Error(`Cannot derive shop origin from URL: ${url}`);
    }

    const existing = await db
        .kysely()
        .selectFrom("products")
        .select(["id", "master_product_id", "shop_origin"])
        .where("url", "=", url)
        .executeTakeFirst();
    if (existing && existing.master_product_id !== null) {
        return {
            masterId: existing.master_product_id,
            productId: existing.id,
            shopOrigin: existing.shop_origin,
            autoIngested: false,
        };
    }

    const hlidac = new HlidacShopuClient();
    const data = await hlidac.getByUrl(url);
    const ingest = await ingestFromHlidacResult({ db, url, data });
    if (ingest.product.master_product_id === null) {
        throw new Error(`Ingest produced product without master_product_id for ${url}`);
    }

    return {
        masterId: ingest.product.master_product_id,
        productId: ingest.product.id,
        shopOrigin: ingest.product.shop_origin,
        autoIngested: true,
    };
}

export async function addFavorite(input: WatchInput): Promise<AddFavoriteResult> {
    const { favorites, db } = repos();
    const resolved = await resolveProductByUrl(input.url);

    let referencePrice: number | null = null;
    let priceQuery = db
        .kysely()
        .selectFrom("current_offers")
        .select(["current_price"])
        .where("master_product_id", "=", resolved.masterId)
        .orderBy("current_price", "asc")
        .limit(1);
    if (input.restricted_to_shop) {
        priceQuery = priceQuery.where("shop_origin", "=", input.restricted_to_shop);
    }

    const lastPrice = await priceQuery.executeTakeFirst();
    if (lastPrice?.current_price !== undefined && lastPrice.current_price !== null) {
        referencePrice = lastPrice.current_price;
    }

    const args: AddFavoriteArgs = {
        master_product_id: resolved.masterId,
        restricted_to_shop: input.restricted_to_shop ?? null,
        target_price: input.target_price ?? null,
        drop_percent: input.drop_percent ?? null,
        drop_absolute: input.drop_absolute ?? null,
        reference_price: referencePrice,
        label: input.label ?? null,
        cooldown_hours: input.cooldown_hours ?? 24,
        notify_back_in_stock: input.notify_back_in_stock,
    };
    const id = await favorites.addFavorite(args);
    log.info({ favoriteId: id, masterId: resolved.masterId, autoIngested: resolved.autoIngested }, "favorite added");
    return { favorite_id: id, master_product_id: resolved.masterId, auto_ingested: resolved.autoIngested };
}

export async function removeFavorite(id: number): Promise<void> {
    const { favorites } = repos();
    await favorites.removeFavorite(id);
}

export async function editFavorite(id: number, patch: EditFavoriteArgs): Promise<Favorite | undefined> {
    const { favorites } = repos();
    await favorites.editFavorite(id, patch);
    return favorites.getFavorite(id);
}

export async function getWatchlist(): Promise<FavoriteWithState[]> {
    const { favorites } = repos();
    return favorites.listWithCurrentState();
}

export const VALID_NOTIFICATION_REASONS: ReadonlySet<NotificationReason> = new Set<NotificationReason>([
    "target-price",
    "drop-percent",
    "drop-absolute",
    "back-in-stock",
]);

export function assertValidReason(reason: string | undefined): NotificationReason | undefined {
    if (reason === undefined) {
        return undefined;
    }

    if (!VALID_NOTIFICATION_REASONS.has(reason as NotificationReason)) {
        throw new Error(
            `Invalid reason "${reason}". Use one of: target-price, drop-percent, drop-absolute, back-in-stock.`
        );
    }

    return reason as NotificationReason;
}

export interface RecentNotificationsArgs {
    limit?: number;
    reason?: NotificationReason;
    shop_origin?: string;
    onlyUnacked?: boolean;
}

export async function getRecentNotifications(args: RecentNotificationsArgs = {}): Promise<Notification[]> {
    const { notifications } = repos();
    if (args.onlyUnacked) {
        return notifications.listUnacked();
    }

    return notifications.listAll({ limit: args.limit ?? 100, reason: args.reason, shop_origin: args.shop_origin });
}

export async function ackNotification(id: number): Promise<void> {
    const { notifications } = repos();
    await notifications.ack(id);
}

export async function ackAllNotifications(): Promise<void> {
    const { notifications } = repos();
    await notifications.ackAll();
}
