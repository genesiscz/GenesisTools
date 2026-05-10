import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { sql } from "kysely";

export interface FreshnessRow {
    last_observed_at: string | null;
    shops_covered: number;
}

export async function freshnessFor(
    db: ShopsDatabase,
    masterIds: number[]
): Promise<Map<number, FreshnessRow>> {
    const out = new Map<number, FreshnessRow>();
    if (masterIds.length === 0) {
        return out;
    }

    const rows = await db
        .kysely()
        .selectFrom("prices as p")
        .innerJoin("products as pr", "pr.id", "p.product_id")
        .where("pr.master_product_id", "in", masterIds)
        .select([
            "pr.master_product_id as master_product_id",
            sql<string | null>`MAX(p.observed_at)`.as("last_observed_at"),
            sql<number>`COUNT(DISTINCT pr.shop_origin)`.as("shops_covered"),
        ])
        .groupBy("pr.master_product_id")
        .execute();

    for (const id of masterIds) {
        out.set(id, { last_observed_at: null, shops_covered: 0 });
    }

    for (const r of rows) {
        if (r.master_product_id === null) {
            continue;
        }

        out.set(r.master_product_id, {
            last_observed_at: r.last_observed_at,
            shops_covered: Number(r.shops_covered),
        });
    }

    return out;
}
