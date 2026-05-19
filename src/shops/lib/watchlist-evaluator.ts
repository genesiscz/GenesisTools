import { logger } from "@app/logger";
import type { FavoritesRepository, FavoriteWithState } from "@app/shops/db/FavoritesRepository";
import type { NotificationReason, NotificationsRepository } from "@app/shops/db/NotificationsRepository";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { NotificationPayload } from "@app/shops/lib/channels/types";
import type { NotificationDispatcher } from "@app/shops/lib/notification-dispatcher";
import { assertSchemaCompatible } from "@app/shops/lib/schema-preflight";

const log = logger.child({ component: "WatchlistEvaluator" });

export interface WatchlistEvaluatorConfig {
    db: ShopsDatabase;
    favorites: FavoritesRepository;
    notifications: NotificationsRepository;
    dispatcher: NotificationDispatcher;
}

export interface TickReport {
    evaluated: number;
    fired: number;
    skippedCooldown: number;
    skippedNoOffer: number;
    skippedNoHit: number;
    durationMs: number;
}

interface ResolvedHit {
    reason: NotificationReason;
    prev: number | null;
    curr: number;
    shop: string;
    productId: number | null;
}

function describeReason(hit: ResolvedHit, fav: FavoriteWithState): string {
    const ref = fav.reference_price ?? hit.prev ?? hit.curr;
    const lines: string[] = [];
    switch (hit.reason) {
        case "target-price":
            lines.push(`Target hit: ${hit.curr.toFixed(2)} ≤ ${(fav.target_price ?? hit.curr).toFixed(2)} CZK.`);
            break;
        case "drop-percent": {
            const pct = ref ? ((ref - hit.curr) / ref) * 100 : 0;
            lines.push(`Drop ${pct.toFixed(1)}% from ${ref?.toFixed(2)} CZK to ${hit.curr.toFixed(2)} CZK.`);
            break;
        }

        case "drop-absolute":
            lines.push(
                `Drop ${(ref - hit.curr).toFixed(2)} CZK from ${ref?.toFixed(2)} to ${hit.curr.toFixed(2)} CZK.`
            );
            break;
        case "back-in-stock":
            lines.push(`Back in stock at ${hit.curr.toFixed(2)} CZK.`);
            break;
    }

    if (fav.label) {
        lines.push(`(${fav.label})`);
    }

    return lines.join(" ");
}

export class WatchlistEvaluator {
    private schemaChecked = false;
    constructor(private readonly config: WatchlistEvaluatorConfig) {}

    async tick(): Promise<TickReport> {
        if (!this.schemaChecked) {
            assertSchemaCompatible(this.config.db);
            this.schemaChecked = true;
        }

        const startedAt = Date.now();
        const favorites = await this.config.favorites.listAllWithCurrentState();
        let fired = 0;
        let skippedCooldown = 0;
        let skippedNoOffer = 0;
        let skippedNoHit = 0;

        for (const fav of favorites) {
            if (fav.best_price === null) {
                skippedNoOffer++;
                log.debug({ favorite_id: fav.id }, "no current offer");
                continue;
            }

            const hit = this.resolveHit(fav);
            if (!hit) {
                skippedNoHit++;
                continue;
            }

            const recent = await this.config.notifications.findRecentByFavoriteAndReason(
                fav.id,
                hit.reason,
                fav.cooldown_hours
            );
            if (recent) {
                skippedCooldown++;
                log.debug({ favorite_id: fav.id, reason: hit.reason, recentId: recent.id }, "cooldown active");
                continue;
            }

            const notificationId = await this.config.notifications.record(fav.user_id, {
                favorite_id: fav.id,
                master_product_id: fav.master_product_id,
                product_id: hit.productId,
                reason: hit.reason,
                prev_price: hit.prev,
                curr_price: hit.curr,
                shop_origin: hit.shop,
                metadata: {},
            });

            const payload = await this.buildPayload({
                favoriteId: fav.id,
                notificationId,
                hit,
                fav,
            });

            await this.config.dispatcher.dispatch(payload);
            fired++;
        }

        const report: TickReport = {
            evaluated: favorites.length,
            fired,
            skippedCooldown,
            skippedNoOffer,
            skippedNoHit,
            durationMs: Date.now() - startedAt,
        };
        log.info(report, "watchlist tick complete");
        return report;
    }

    private resolveHit(fav: FavoriteWithState): ResolvedHit | null {
        const cur = fav.best_price;
        if (cur === null || fav.best_shop === null) {
            return null;
        }

        const ref = fav.reference_price;

        if (fav.target_price !== null && cur <= fav.target_price) {
            return { reason: "target-price", prev: ref, curr: cur, shop: fav.best_shop, productId: null };
        }

        if (fav.drop_percent !== null && ref !== null && ref > 0 && (ref - cur) / ref >= fav.drop_percent) {
            return { reason: "drop-percent", prev: ref, curr: cur, shop: fav.best_shop, productId: null };
        }

        if (fav.drop_absolute !== null && ref !== null && ref - cur >= fav.drop_absolute) {
            return { reason: "drop-absolute", prev: ref, curr: cur, shop: fav.best_shop, productId: null };
        }

        if (fav.notify_back_in_stock === 1) {
            return { reason: "back-in-stock", prev: ref, curr: cur, shop: fav.best_shop, productId: null };
        }

        return null;
    }

    private async buildPayload(args: {
        favoriteId: number;
        notificationId: number;
        hit: ResolvedHit;
        fav: FavoriteWithState;
    }): Promise<NotificationPayload> {
        const { favoriteId, notificationId, hit, fav } = args;
        const masterRow = await this.config.db
            .kysely()
            .selectFrom("master_products")
            .select(["canonical_name"])
            .where("id", "=", fav.master_product_id)
            .executeTakeFirst();
        const productRow = await this.config.db
            .kysely()
            .selectFrom("products")
            .select(["url"])
            .where("master_product_id", "=", fav.master_product_id)
            .where("shop_origin", "=", hit.shop)
            .executeTakeFirst();

        const name = masterRow?.canonical_name ?? `master#${fav.master_product_id}`;
        const reasonText = describeReason(hit, fav);
        return {
            notification: {
                id: notificationId,
                user_id: fav.user_id,
                favorite_id: favoriteId,
                master_product_id: fav.master_product_id,
                product_id: hit.productId,
                fired_at: new Date().toISOString(),
                reason: hit.reason,
                prev_price: hit.prev,
                curr_price: hit.curr,
                shop_origin: hit.shop,
                delivered_macos_at: null,
                delivered_web_at: null,
                delivered_telegram_at: null,
                delivery_error: null,
                acknowledged_at: null,
                metadata_json: "{}",
            },
            title: `${name} — ${hit.curr.toFixed(2)} CZK on ${hit.shop}`,
            body: reasonText,
            detailUrl: `/master/${fav.master_product_id}`,
            buyUrl: productRow?.url ?? null,
        };
    }
}
