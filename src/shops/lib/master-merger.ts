import logger from "@app/logger";
import type { ShopsDatabase } from "../db/ShopsDatabase";

const log = logger.child({
    component: "MasterMerger",
    instance: Math.random().toString(36).slice(2, 8),
});

export interface MergeArgs {
    survivorMasterId: number;
    absorbedMasterId: number;
}

export interface MergeResult {
    survivorMasterId: number;
    absorbedMasterId: number;
    productsMoved: number;
    favoritesMoved: number;
    notificationsMoved: number;
}

export class MasterMerger {
    constructor(private readonly shopsDb: ShopsDatabase) {}

    async merge(args: MergeArgs): Promise<MergeResult> {
        if (args.survivorMasterId === args.absorbedMasterId) {
            throw new Error("MasterMerger.merge: survivor and absorbed are the same id");
        }

        const db = this.shopsDb.raw();
        const now = new Date().toISOString();

        const productsMoved =
            db
                .query<{ n: number }, [number]>(
                    "SELECT COUNT(*) AS n FROM products WHERE master_product_id = ?"
                )
                .get(args.absorbedMasterId)?.n ?? 0;
        db.run(
            "UPDATE products SET master_product_id = ?, last_updated_at = ? WHERE master_product_id = ?",
            [args.survivorMasterId, now, args.absorbedMasterId]
        );

        const favoritesMoved =
            db
                .query<{ n: number }, [number]>(
                    "SELECT COUNT(*) AS n FROM favorites WHERE master_product_id = ?"
                )
                .get(args.absorbedMasterId)?.n ?? 0;
        db.run("UPDATE favorites SET master_product_id = ? WHERE master_product_id = ?", [
            args.survivorMasterId,
            args.absorbedMasterId,
        ]);

        const notificationsMoved =
            db
                .query<{ n: number }, [number]>(
                    "SELECT COUNT(*) AS n FROM notifications WHERE master_product_id = ?"
                )
                .get(args.absorbedMasterId)?.n ?? 0;
        db.run("UPDATE notifications SET master_product_id = ? WHERE master_product_id = ?", [
            args.survivorMasterId,
            args.absorbedMasterId,
        ]);

        db.run("DELETE FROM master_products WHERE id = ?", [args.absorbedMasterId]);

        db.run(
            `UPDATE master_products SET total_offers = (
                SELECT COUNT(*) FROM products WHERE master_product_id = ? AND is_active = 1
             ), updated_at = ? WHERE id = ?`,
            [args.survivorMasterId, now, args.survivorMasterId]
        );

        const best = db
            .query<
                { current_price: number; shop_origin: string; price_observed_at: string },
                [number]
            >(
                `SELECT current_price, shop_origin, price_observed_at
                 FROM current_offers
                 WHERE master_product_id = ? AND current_price IS NOT NULL
                 ORDER BY current_price ASC LIMIT 1`
            )
            .get(args.survivorMasterId);

        if (best) {
            db.run(
                "UPDATE master_products SET best_price = ?, best_price_shop = ?, best_price_at = ? WHERE id = ?",
                [best.current_price, best.shop_origin, best.price_observed_at, args.survivorMasterId]
            );
        } else {
            db.run(
                "UPDATE master_products SET best_price = NULL, best_price_shop = NULL, best_price_at = NULL WHERE id = ?",
                [args.survivorMasterId]
            );
        }

        log.info(
            {
                survivorMasterId: args.survivorMasterId,
                absorbedMasterId: args.absorbedMasterId,
                productsMoved,
                favoritesMoved,
                notificationsMoved,
            },
            "master merged"
        );

        return {
            survivorMasterId: args.survivorMasterId,
            absorbedMasterId: args.absorbedMasterId,
            productsMoved,
            favoritesMoved,
            notificationsMoved,
        };
    }

    pickSurvivor(
        masterIdA: number,
        masterIdB: number
    ): { survivorMasterId: number; absorbedMasterId: number } {
        const db = this.shopsDb.raw();
        const a = db
            .query<{ id: number; total_offers: number }, [number]>(
                "SELECT id, total_offers FROM master_products WHERE id = ?"
            )
            .get(masterIdA);
        const b = db
            .query<{ id: number; total_offers: number }, [number]>(
                "SELECT id, total_offers FROM master_products WHERE id = ?"
            )
            .get(masterIdB);
        if (!a || !b) {
            throw new Error(`pickSurvivor: master not found (a=${masterIdA}, b=${masterIdB})`);
        }

        if (a.total_offers > b.total_offers) {
            return { survivorMasterId: a.id, absorbedMasterId: b.id };
        }

        if (b.total_offers > a.total_offers) {
            return { survivorMasterId: b.id, absorbedMasterId: a.id };
        }

        return a.id < b.id
            ? { survivorMasterId: a.id, absorbedMasterId: b.id }
            : { survivorMasterId: b.id, absorbedMasterId: a.id };
    }
}
