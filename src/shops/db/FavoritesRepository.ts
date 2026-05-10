import logger from "@app/logger";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { FavoritesTable } from "@app/shops/db/types";
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
}

interface CurrentStateRow {
    id: number;
    user_id: number;
    master_product_id: number;
    restricted_to_shop: string | null;
    label: string | null;
    target_price: number | null;
    drop_percent: number | null;
    drop_absolute: number | null;
    reference_price: number | null;
    notify_back_in_stock: number;
    cooldown_hours: number;
    active: number;
    created_at: string;
    best_price: number | null;
    best_shop: string | null;
    best_observed_at: string | null;
}

export class FavoritesRepository {
    constructor(private readonly db: ShopsDatabase) {}

    async addFavorite(args: AddFavoriteArgs): Promise<number> {
        const result = await this.db
            .kysely()
            .insertInto("favorites")
            .values({
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
        log.debug({ favoriteId: id, master: args.master_product_id }, "favorite added");
        return id;
    }

    async removeFavorite(id: number): Promise<void> {
        await this.db.kysely().deleteFrom("favorites").where("id", "=", id).execute();
        log.debug({ favoriteId: id }, "favorite removed");
    }

    async editFavorite(id: number, patch: EditFavoriteArgs): Promise<void> {
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

        await this.db.kysely().updateTable("favorites").set(update).where("id", "=", id).execute();
    }

    async getFavorite(id: number): Promise<Favorite | undefined> {
        return this.db.kysely().selectFrom("favorites").selectAll().where("id", "=", id).executeTakeFirst();
    }

    async listActive(): Promise<Favorite[]> {
        return this.db.kysely().selectFrom("favorites").selectAll().where("active", "=", 1).execute();
    }

    async listWithCurrentState(): Promise<FavoriteWithState[]> {
        const rows = this.db
            .raw()
            .query<CurrentStateRow, []>(
                `SELECT f.*,
                        co.current_price   AS best_price,
                        co.shop_origin     AS best_shop,
                        co.price_observed_at AS best_observed_at
                 FROM favorites f
                 LEFT JOIN current_offers co
                   ON co.master_product_id = f.master_product_id
                  AND (f.restricted_to_shop IS NULL OR co.shop_origin = f.restricted_to_shop)
                  AND co.current_price = (
                    SELECT MIN(co2.current_price)
                    FROM current_offers co2
                    WHERE co2.master_product_id = f.master_product_id
                      AND (f.restricted_to_shop IS NULL OR co2.shop_origin = f.restricted_to_shop)
                  )
                 WHERE f.active = 1
                 GROUP BY f.id`
            )
            .all();

        return rows.map((r) => {
            const ref = r.reference_price;
            const cur = r.best_price;
            const delta_absolute = ref !== null && cur !== null ? ref - cur : null;
            const delta_percent = ref !== null && ref > 0 && cur !== null ? (ref - cur) / ref : null;
            return { ...r, delta_absolute, delta_percent };
        });
    }
}
