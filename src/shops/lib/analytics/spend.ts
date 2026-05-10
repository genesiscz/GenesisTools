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
    let q = db
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
