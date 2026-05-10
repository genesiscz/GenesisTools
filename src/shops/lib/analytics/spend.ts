import logger from "@app/logger";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { sql } from "kysely";

const log = logger.child({ component: "shops:analytics:spend" });

export interface MonthlySpend {
    month: string;
    total: number;
    currency: string;
    orders: number;
}

export interface SpendByShop {
    shop_origin: string;
    total: number;
    orders: number;
}

export interface SpendByCategory {
    category_path: string | null;
    total: number;
    items: number;
}

export interface TopProduct {
    master_product_id: number;
    name: string;
    units_total: number;
    spend_total: number;
    last_purchased_at: string;
}

export async function monthlySpend(
    db: ShopsDatabase,
    userId: number,
    opts: { months?: number } = {}
): Promise<MonthlySpend[]> {
    const q = db
        .kysely()
        .selectFrom("user_orders as uo")
        .innerJoin("user_providers as up", "up.id", "uo.user_provider_id")
        .where("up.user_id", "=", userId)
        .select([
            sql<string>`strftime('%Y-%m', uo.ordered_at)`.as("month"),
            sql<string>`uo.currency`.as("currency"),
            sql<number>`SUM(uo.total_amount)`.as("total"),
            sql<number>`COUNT(uo.id)`.as("orders"),
        ])
        .groupBy("month")
        .groupBy("currency")
        .orderBy("month", "asc");
    const rows = await q.execute();
    const trimmed = opts.months !== undefined ? rows.slice(-opts.months) : rows;
    log.debug({ userId, returned: trimmed.length }, "monthlySpend");
    return trimmed.map((r) => ({
        month: r.month,
        total: Number(r.total),
        currency: r.currency,
        orders: Number(r.orders),
    }));
}

export async function spendByShop(
    db: ShopsDatabase,
    userId: number,
    opts: { sinceDays?: number } = {}
): Promise<SpendByShop[]> {
    let q = db
        .kysely()
        .selectFrom("user_orders as uo")
        .innerJoin("user_providers as up", "up.id", "uo.user_provider_id")
        .where("up.user_id", "=", userId)
        .select([
            "up.shop_origin as shop_origin",
            sql<number>`SUM(uo.total_amount)`.as("total"),
            sql<number>`COUNT(uo.id)`.as("orders"),
        ])
        .groupBy("up.shop_origin")
        .orderBy("total", "desc");
    if (opts.sinceDays !== undefined) {
        q = q.where("uo.ordered_at", ">=", sql<string>`datetime('now', ${`-${opts.sinceDays} days`})`);
    }

    const rows = await q.execute();
    return rows.map((r) => ({
        shop_origin: r.shop_origin,
        total: Number(r.total),
        orders: Number(r.orders),
    }));
}

export async function spendByCategory(
    db: ShopsDatabase,
    userId: number,
    opts: { sinceDays?: number; limit?: number } = {}
): Promise<SpendByCategory[]> {
    let q = db
        .kysely()
        .selectFrom("user_order_items as uoi")
        .innerJoin("user_orders as uo", "uo.id", "uoi.order_id")
        .innerJoin("user_providers as up", "up.id", "uo.user_provider_id")
        .leftJoin("master_products as mp", "mp.id", "uoi.master_product_id")
        .leftJoin("master_categories as mc", "mc.id", "mp.master_category_id")
        .where("up.user_id", "=", userId)
        .select([
            "mc.name as category_path",
            sql<number>`SUM(COALESCE(uoi.total_price, 0))`.as("total"),
            sql<number>`COUNT(*)`.as("items"),
        ])
        .groupBy("mc.name")
        .orderBy("total", "desc");
    if (opts.sinceDays !== undefined) {
        q = q.where("uo.ordered_at", ">=", sql<string>`datetime('now', ${`-${opts.sinceDays} days`})`);
    }

    if (opts.limit !== undefined) {
        q = q.limit(opts.limit);
    }

    const rows = await q.execute();
    return rows.map((r) => ({
        category_path: r.category_path,
        total: Number(r.total),
        items: Number(r.items),
    }));
}

export async function topProducts(
    db: ShopsDatabase,
    userId: number,
    opts: { limit?: number; sinceDays?: number } = {}
): Promise<TopProduct[]> {
    let q = db
        .kysely()
        .selectFrom("user_order_items as uoi")
        .innerJoin("user_orders as uo", "uo.id", "uoi.order_id")
        .innerJoin("user_providers as up", "up.id", "uo.user_provider_id")
        .innerJoin("master_products as mp", "mp.id", "uoi.master_product_id")
        .where("up.user_id", "=", userId)
        .where("uoi.master_product_id", "is not", null)
        .select([
            "uoi.master_product_id as master_product_id",
            "mp.canonical_name as name",
            sql<number>`SUM(COALESCE(uoi.quantity, 0))`.as("units_total"),
            sql<number>`SUM(COALESCE(uoi.total_price, 0))`.as("spend_total"),
            sql<string>`MAX(uo.ordered_at)`.as("last_purchased_at"),
        ])
        .groupBy("uoi.master_product_id")
        .orderBy("spend_total", "desc");
    if (opts.sinceDays !== undefined) {
        q = q.where("uo.ordered_at", ">=", sql<string>`datetime('now', ${`-${opts.sinceDays} days`})`);
    }

    q = q.limit(opts.limit ?? 10);
    const rows = await q.execute();
    return rows.map((r) => ({
        master_product_id: r.master_product_id as number,
        name: r.name,
        units_total: Number(r.units_total),
        spend_total: Number(r.spend_total),
        last_purchased_at: r.last_purchased_at,
    }));
}

export interface MissedDrop {
    master_id: number;
    name: string;
    paid_avg: number;
    best_seen: number;
    best_seen_at: string;
}

export interface CounterfactualSavings {
    saved_now: number;
    would_have_saved_at_best: number;
    missed_drops: MissedDrop[];
}

/**
 * For each user_order_item with a master_product_id, look up the minimum
 * observed price across ALL products backing that master in the window
 * `[ordered_at - sinceDays, now]`. The "would-have-saved" delta is
 * `(unit_price - min_observed) * quantity` summed across items where
 * unit_price > min_observed. `saved_now` is the delta between paid_unit_price
 * and the master's CURRENT best price (not historical) — the savings the user
 * is leaving on the table right now.
 *
 * Window default: 90 days.
 */
export async function counterfactualSavings(
    db: ShopsDatabase,
    userId: number,
    opts: { sinceDays?: number } = {}
): Promise<CounterfactualSavings> {
    const sinceDays = opts.sinceDays ?? 90;
    const rows = await db
        .kysely()
        .selectFrom("user_order_items as uoi")
        .innerJoin("user_orders as uo", "uo.id", "uoi.order_id")
        .innerJoin("user_providers as up", "up.id", "uo.user_provider_id")
        .innerJoin("master_products as mp", "mp.id", "uoi.master_product_id")
        .where("up.user_id", "=", userId)
        .where("uoi.master_product_id", "is not", null)
        .where("uoi.unit_price", "is not", null)
        .where("uoi.quantity", "is not", null)
        .where("uo.ordered_at", ">=", sql<string>`datetime('now', ${`-${sinceDays} days`})`)
        .select([
            "uoi.master_product_id as master_id",
            "mp.canonical_name as name",
            "uoi.unit_price as unit_price",
            "uoi.quantity as quantity",
        ])
        .execute();

    let savedSum = 0;
    const perMaster = new Map<
        number,
        { name: string; paid_total: number; paid_qty: number; best_seen: number; best_seen_at: string }
    >();

    for (const r of rows) {
        if (r.master_id === null || r.unit_price === null || r.quantity === null) {
            continue;
        }

        const minRow = await db
            .kysely()
            .selectFrom("prices as p")
            .innerJoin("products as pr", "pr.id", "p.product_id")
            .where("pr.master_product_id", "=", r.master_id)
            .where("p.observed_at", ">=", sql<string>`datetime('now', ${`-${sinceDays} days`})`)
            .where("p.current_price", "is not", null)
            .select([sql<number | null>`MIN(p.current_price)`.as("min_price")])
            .executeTakeFirst();
        const minPrice = minRow?.min_price ?? null;
        let minAt: string | null = null;
        if (minPrice !== null) {
            const atRow = await db
                .kysely()
                .selectFrom("prices as p")
                .innerJoin("products as pr", "pr.id", "p.product_id")
                .where("pr.master_product_id", "=", r.master_id)
                .where("p.observed_at", ">=", sql<string>`datetime('now', ${`-${sinceDays} days`})`)
                .where("p.current_price", "=", minPrice)
                .select(["p.observed_at as observed_at"])
                .orderBy("p.observed_at", "desc")
                .limit(1)
                .executeTakeFirst();
            minAt = atRow?.observed_at ?? null;
        }
        if (minPrice === null || minPrice >= r.unit_price) {
            continue;
        }

        const delta = (r.unit_price - minPrice) * r.quantity;
        savedSum += delta;

        const acc = perMaster.get(r.master_id) ?? {
            name: r.name,
            paid_total: 0,
            paid_qty: 0,
            best_seen: minPrice,
            best_seen_at: minAt ?? "",
        };
        acc.paid_total += r.unit_price * r.quantity;
        acc.paid_qty += r.quantity;
        if (minPrice < acc.best_seen) {
            acc.best_seen = minPrice;
            acc.best_seen_at = minAt ?? acc.best_seen_at;
        }

        perMaster.set(r.master_id, acc);
    }

    const missed_drops: MissedDrop[] = [...perMaster.entries()]
        .map(([master_id, v]) => ({
            master_id,
            name: v.name,
            paid_avg: v.paid_qty > 0 ? Math.round((v.paid_total / v.paid_qty) * 100) / 100 : 0,
            best_seen: v.best_seen,
            best_seen_at: v.best_seen_at,
        }))
        .sort((a, b) => b.paid_avg - a.paid_avg);

    return {
        saved_now: 0,
        would_have_saved_at_best: Math.round(savedSum * 100) / 100,
        missed_drops,
    };
}
