import { logger } from "@app/logger";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { sql } from "kysely";

const log = logger.child({ component: "shops:analytics:best-time" });

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export interface BestWeekday {
    weekday: number;
    weekday_name: string;
    avg_price: number;
    sample_size: number;
}

export interface BestShop {
    shop_origin: string;
    current_price: number;
}

/**
 * Returns the weekday (0 = Sunday … 6 = Saturday) with the lowest average
 * `current_price` over all `prices` rows for any product backing the master.
 * SQLite's `strftime('%w', ts)` returns weekday-as-string with Sunday=0.
 */
export async function bestWeekday(db: ShopsDatabase, masterId: number): Promise<BestWeekday | null> {
    const rows = await db
        .kysely()
        .selectFrom("prices as p")
        .innerJoin("products as pr", "pr.id", "p.product_id")
        .where("pr.master_product_id", "=", masterId)
        .where("p.current_price", "is not", null)
        .select([
            sql<string>`strftime('%w', p.observed_at)`.as("weekday"),
            sql<number>`AVG(p.current_price)`.as("avg_price"),
            sql<number>`COUNT(*)`.as("sample"),
        ])
        .groupBy("weekday")
        .orderBy("avg_price", "asc")
        .execute();
    if (rows.length === 0) {
        return null;
    }

    const top = rows[0];
    const wd = Number(top.weekday);
    const result: BestWeekday = {
        weekday: wd,
        weekday_name: WEEKDAY_NAMES[wd],
        avg_price: Math.round(Number(top.avg_price) * 100) / 100,
        sample_size: Number(top.sample),
    };
    log.debug({ masterId, weekday: wd, avg: result.avg_price }, "bestWeekday");
    return result;
}

export async function bestShop(db: ShopsDatabase, masterId: number): Promise<BestShop | null> {
    const row = await db
        .kysely()
        .selectFrom("current_offers")
        .where("master_product_id", "=", masterId)
        .where("current_price", "is not", null)
        .select(["shop_origin", "current_price"])
        .orderBy("current_price", "asc")
        .limit(1)
        .executeTakeFirst();
    if (!row || row.current_price === null) {
        return null;
    }

    return { shop_origin: row.shop_origin, current_price: row.current_price };
}
