import { logger } from "@app/logger";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { refreshMasterDenorm } from "@app/shops/lib/master-denorm";

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

        const k = this.shopsDb.kysely();
        const now = new Date().toISOString();

        const productsCount = await k
            .selectFrom("products")
            .select((eb) => eb.fn.countAll<number>().as("n"))
            .where("master_product_id", "=", args.absorbedMasterId)
            .executeTakeFirst();
        const productsMoved = productsCount?.n ?? 0;

        await k
            .updateTable("products")
            .set({ master_product_id: args.survivorMasterId, last_updated_at: now })
            .where("master_product_id", "=", args.absorbedMasterId)
            .execute();

        const favoritesCount = await k
            .selectFrom("favorites")
            .select((eb) => eb.fn.countAll<number>().as("n"))
            .where("master_product_id", "=", args.absorbedMasterId)
            .executeTakeFirst();
        const favoritesMoved = favoritesCount?.n ?? 0;

        await k
            .updateTable("favorites")
            .set({ master_product_id: args.survivorMasterId })
            .where("master_product_id", "=", args.absorbedMasterId)
            .execute();

        const notificationsCount = await k
            .selectFrom("notifications")
            .select((eb) => eb.fn.countAll<number>().as("n"))
            .where("master_product_id", "=", args.absorbedMasterId)
            .executeTakeFirst();
        const notificationsMoved = notificationsCount?.n ?? 0;

        await k
            .updateTable("notifications")
            .set({ master_product_id: args.survivorMasterId })
            .where("master_product_id", "=", args.absorbedMasterId)
            .execute();

        await k.deleteFrom("master_products").where("id", "=", args.absorbedMasterId).execute();

        // Refresh denorm on survivor — refreshMasterDenorm now takes ShopsDatabase + is async (Task 4a).
        await refreshMasterDenorm(this.shopsDb, args.survivorMasterId);

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

    async pickSurvivor(
        masterIdA: number,
        masterIdB: number
    ): Promise<{ survivorMasterId: number; absorbedMasterId: number }> {
        const k = this.shopsDb.kysely();
        const a = await k
            .selectFrom("master_products")
            .select(["id", "total_offers"])
            .where("id", "=", masterIdA)
            .executeTakeFirst();
        const b = await k
            .selectFrom("master_products")
            .select(["id", "total_offers"])
            .where("id", "=", masterIdB)
            .executeTakeFirst();
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
