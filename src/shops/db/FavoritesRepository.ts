import logger from "@app/logger";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { FavoritesTable } from "@app/shops/db/types";
import { freshnessFor } from "@app/shops/lib/analytics/freshness";
import { nowUtcIso } from "@app/utils/sql-time";
import type { Selectable } from "kysely";

const log = logger.child({ component: "FavoritesRepository" });

export interface AddFavoriteArgs {
    master_product_id: number;
    restricted_to_shop: string | null;
    target_price: number | null;
    drop_percent: number | null;
    drop_absolute: number | null;
    reference_price: number | null;
    label: string | null;
    cooldown_hours: number;
    notify_back_in_stock?: boolean;
}

export interface EditFavoriteArgs {
    target_price?: number | null;
    drop_percent?: number | null;
    drop_absolute?: number | null;
    reference_price?: number | null;
    label?: string | null;
    cooldown_hours?: number;
    notify_back_in_stock?: boolean;
    active?: boolean;
}

export type Favorite = Selectable<FavoritesTable>;

export interface FavoriteWithState extends Favorite {
    best_price: number | null;
    best_shop: string | null;
    best_observed_at: string | null;
    delta_percent: number | null;
    delta_absolute: number | null;
    last_observed_at: string | null;
    shops_covered: number;
}

export class FavoritesRepository {
    constructor(private readonly db: ShopsDatabase) {}

    async addFavorite(userId: number, args: AddFavoriteArgs): Promise<number> {
        const result = await this.db
            .kysely()
            .insertInto("favorites")
            .values({
                user_id: userId,
                master_product_id: args.master_product_id,
                restricted_to_shop: args.restricted_to_shop,
                target_price: args.target_price,
                drop_percent: args.drop_percent,
                drop_absolute: args.drop_absolute,
                reference_price: args.reference_price,
                label: args.label,
                cooldown_hours: args.cooldown_hours,
                notify_back_in_stock: args.notify_back_in_stock ? 1 : 0,
                active: 1,
                created_at: nowUtcIso(),
            })
            .executeTakeFirstOrThrow();
        const id = Number(result.insertId ?? 0);
        log.debug({ favoriteId: id, userId, master: args.master_product_id }, "favorite added");
        return id;
    }

    async removeFavorite(userId: number, id: number): Promise<void> {
        await this.db.kysely().deleteFrom("favorites").where("id", "=", id).where("user_id", "=", userId).execute();
        log.debug({ favoriteId: id, userId }, "favorite removed");
    }

    async editFavorite(userId: number, id: number, patch: EditFavoriteArgs): Promise<void> {
        const update: Record<string, unknown> = {};
        if (patch.target_price !== undefined) {
            update.target_price = patch.target_price;
        }

        if (patch.drop_percent !== undefined) {
            update.drop_percent = patch.drop_percent;
        }

        if (patch.drop_absolute !== undefined) {
            update.drop_absolute = patch.drop_absolute;
        }

        if (patch.reference_price !== undefined) {
            update.reference_price = patch.reference_price;
        }

        if (patch.label !== undefined) {
            update.label = patch.label;
        }

        if (patch.cooldown_hours !== undefined) {
            update.cooldown_hours = patch.cooldown_hours;
        }

        if (patch.notify_back_in_stock !== undefined) {
            update.notify_back_in_stock = patch.notify_back_in_stock ? 1 : 0;
        }

        if (patch.active !== undefined) {
            update.active = patch.active ? 1 : 0;
        }

        if (Object.keys(update).length === 0) {
            return;
        }

        await this.db
            .kysely()
            .updateTable("favorites")
            .set(update)
            .where("id", "=", id)
            .where("user_id", "=", userId)
            .execute();
    }

    async getFavorite(userId: number, id: number): Promise<Favorite | undefined> {
        return this.db
            .kysely()
            .selectFrom("favorites")
            .selectAll()
            .where("id", "=", id)
            .where("user_id", "=", userId)
            .executeTakeFirst();
    }

    async listActive(userId: number): Promise<Favorite[]> {
        return this.db
            .kysely()
            .selectFrom("favorites")
            .selectAll()
            .where("user_id", "=", userId)
            .where("active", "=", 1)
            .execute();
    }

    /** Cross-user variant — used by the watchlist evaluator daemon which iterates ALL users' favorites. */
    async listAllActive(): Promise<Favorite[]> {
        return this.db.kysely().selectFrom("favorites").selectAll().where("active", "=", 1).execute();
    }

    async listWithCurrentState(userId: number): Promise<FavoriteWithState[]> {
        return this.queryWithCurrentState(userId);
    }

    /** Cross-user variant — used by the watchlist evaluator daemon which scans every user's favorites. */
    async listAllWithCurrentState(): Promise<FavoriteWithState[]> {
        return this.queryWithCurrentState(null);
    }

    private async queryWithCurrentState(userId: number | null): Promise<FavoriteWithState[]> {
        let q = this.db
            .kysely()
            .selectFrom("favorites as f")
            .leftJoin("current_offers as co", (join) =>
                join
                    .onRef("co.master_product_id", "=", "f.master_product_id")
                    .on((eb) =>
                        eb.or([
                            eb("f.restricted_to_shop", "is", null),
                            eb("co.shop_origin", "=", eb.ref("f.restricted_to_shop")),
                        ])
                    )
                    .on("co.current_price", "=", (eb) =>
                        eb
                            .selectFrom("current_offers as co2")
                            .select((sub) => sub.fn.min("co2.current_price").as("min_price"))
                            .whereRef("co2.master_product_id", "=", "f.master_product_id")
                            .where((sub) =>
                                sub.or([
                                    sub("f.restricted_to_shop", "is", null),
                                    sub("co2.shop_origin", "=", sub.ref("f.restricted_to_shop")),
                                ])
                            )
                    )
            )
            .select([
                "f.id",
                "f.user_id",
                "f.master_product_id",
                "f.restricted_to_shop",
                "f.label",
                "f.target_price",
                "f.drop_percent",
                "f.drop_absolute",
                "f.reference_price",
                "f.notify_back_in_stock",
                "f.cooldown_hours",
                "f.active",
                "f.created_at",
                "co.current_price as best_price",
                "co.shop_origin as best_shop",
                "co.price_observed_at as best_observed_at",
            ])
            .where("f.active", "=", 1)
            .groupBy("f.id");
        if (userId !== null) {
            q = q.where("f.user_id", "=", userId);
        }

        const rows = await q.execute();
        const baseMapped = rows.map((r) => {
            const ref = r.reference_price;
            const cur = r.best_price;
            const delta_absolute = ref !== null && cur !== null ? ref - cur : null;
            const delta_percent = ref !== null && ref > 0 && cur !== null ? (ref - cur) / ref : null;
            return { ...r, delta_absolute, delta_percent };
        });

        if (baseMapped.length === 0) {
            return baseMapped.map((r) => ({ ...r, last_observed_at: null, shops_covered: 0 }));
        }

        const masterIds = [...new Set(baseMapped.map((r) => r.master_product_id))];
        const freshness = await freshnessFor(this.db, masterIds);
        return baseMapped.map((r) => {
            const f = freshness.get(r.master_product_id);
            return {
                ...r,
                last_observed_at: f?.last_observed_at ?? null,
                shops_covered: f?.shops_covered ?? 0,
            };
        });
    }
}
