import { logger } from "@app/logger";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";

const log = logger.child({ component: "shops:analytics:recurring" });

export type Confidence = "high" | "medium" | "low";

export interface RecurringPurchase {
    master_product_id: number;
    name: string;
    avg_interval_days: number;
    last_purchased_at: string;
    next_likely_at: string;
    confidence: Confidence;
    occurrence_count: number;
}

export interface DetectRecurringOpts {
    minOccurrences?: number;
}

const MS_PER_DAY = 86_400_000;

function classifyConfidence(intervals: number[]): Confidence {
    if (intervals.length === 0) {
        return "low";
    }

    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    if (mean === 0) {
        return "low";
    }

    const variance = intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length;
    const stddev = Math.sqrt(variance);
    const cv = stddev / mean;
    if (cv <= 0.5) {
        return "high";
    }

    if (cv <= 1.0) {
        return "medium";
    }

    return "low";
}

export async function detectRecurring(
    db: ShopsDatabase,
    userId: number,
    opts: DetectRecurringOpts = {}
): Promise<RecurringPurchase[]> {
    const minOccurrences = opts.minOccurrences ?? 3;
    const rows = await db
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
            "uo.ordered_at as ordered_at",
        ])
        .orderBy("uoi.master_product_id")
        .orderBy("uo.ordered_at", "asc")
        .execute();

    const grouped = new Map<number, { name: string; dates: string[] }>();
    for (const r of rows) {
        if (r.master_product_id === null) {
            continue;
        }

        const acc = grouped.get(r.master_product_id) ?? { name: r.name, dates: [] };
        acc.dates.push(r.ordered_at);
        grouped.set(r.master_product_id, acc);
    }

    const result: RecurringPurchase[] = [];
    for (const [master_product_id, { name, dates }] of grouped) {
        if (dates.length < minOccurrences) {
            continue;
        }

        const ts = dates.map((d) => new Date(d).getTime()).sort((a, b) => a - b);
        const intervals: number[] = [];
        for (let i = 1; i < ts.length; i++) {
            intervals.push((ts[i] - ts[i - 1]) / MS_PER_DAY);
        }

        const avg_interval_days = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const lastTs = ts[ts.length - 1];
        const nextTs = lastTs + avg_interval_days * MS_PER_DAY;
        result.push({
            master_product_id,
            name,
            avg_interval_days: Math.round(avg_interval_days * 10) / 10,
            last_purchased_at: new Date(lastTs).toISOString(),
            next_likely_at: new Date(nextTs).toISOString(),
            confidence: classifyConfidence(intervals),
            occurrence_count: dates.length,
        });
    }

    result.sort((a, b) => new Date(a.next_likely_at).getTime() - new Date(b.next_likely_at).getTime());
    log.debug({ userId, returned: result.length }, "detectRecurring");
    return result;
}
