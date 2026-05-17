import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { detectRecurring } from "@app/shops/lib/analytics/recurring";

function fixture(): { db: ShopsDatabase; userId: number } {
    const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-rec-")), "test.db"));
    const r = db.raw();
    r.exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
            VALUES ('rohlik.cz','Rohlík.cz','CZK',1,1,1,1,1,'none')`);
    r.exec(`INSERT INTO master_products (id, canonical_name, canonical_name_normalized, canonical_slug, created_at, updated_at)
            VALUES (10, 'Milk 1l', 'milk 1l', 'milk-1l', datetime('now'), datetime('now')),
                   (11, 'Eggs',    'eggs',    'eggs',    datetime('now'), datetime('now')),
                   (12, 'Once',    'once',    'once',    datetime('now'), datetime('now'))`);
    r.exec(`INSERT INTO user_providers (id, user_id, shop_origin, status, created_at, updated_at)
            VALUES (1, 1, 'rohlik.cz', 'connected', datetime('now'), datetime('now'))`);
    // Milk: weekly cadence (~7 days), 5 occurrences -> high confidence
    const milkDates = ["2026-04-05", "2026-04-12", "2026-04-19", "2026-04-26", "2026-05-03"];
    // Eggs: jittery intervals (2, 25, 14, 13) -> CV ~0.60 -> medium confidence
    const eggDates = ["2026-03-20", "2026-03-22", "2026-04-16", "2026-04-30", "2026-05-13"];
    // Once: only 2 purchases -> below threshold, NOT returned
    const onceDates = ["2026-02-01", "2026-04-01"];
    let orderId = 100;
    for (const [masterId, dates] of [
        [10, milkDates],
        [11, eggDates],
        [12, onceDates],
    ] as const) {
        for (const d of dates) {
            r.exec(`INSERT INTO user_orders (id, user_provider_id, external_order_id, ordered_at, total_amount, currency, items_count, ingested_at)
                    VALUES (${orderId}, 1, '${masterId}-${d}', '${d}T10:00:00Z', 50, 'CZK', 1, datetime('now'))`);
            r.exec(`INSERT INTO user_order_items (order_id, line_no, name, quantity, unit_price, total_price, master_product_id)
                    VALUES (${orderId}, 1, 'X', 1, 50, 50, ${masterId})`);
            orderId++;
        }
    }
    return { db, userId: 1 };
}

describe("detectRecurring", () => {
    it("returns regulars with at least minOccurrences purchases", async () => {
        const { db, userId } = fixture();
        const rows = await detectRecurring(db, userId);
        const ids = rows.map((r) => r.master_product_id).sort();
        expect(ids).toEqual([10, 11]);
    });

    it("computes avg_interval_days and next_likely_at = last + avg", async () => {
        const { db, userId } = fixture();
        const rows = await detectRecurring(db, userId);
        const milk = rows.find((r) => r.master_product_id === 10);
        expect(milk).toBeDefined();
        expect(milk?.occurrence_count).toBe(5);
        expect(Math.round(milk?.avg_interval_days ?? 0)).toBe(7);
        expect(milk?.confidence).toBe("high");
        expect(milk?.last_purchased_at).toBe("2026-05-03T10:00:00.000Z");
        expect(new Date(milk?.next_likely_at ?? "").getTime()).toBeGreaterThan(
            new Date("2026-05-03T10:00:00Z").getTime()
        );
    });

    it("low/medium confidence reflects interval variance", async () => {
        const { db, userId } = fixture();
        const rows = await detectRecurring(db, userId);
        const eggs = rows.find((r) => r.master_product_id === 11);
        expect(eggs?.confidence === "medium" || eggs?.confidence === "low").toBe(true);
    });

    it("respects minOccurrences override", async () => {
        const { db, userId } = fixture();
        const rows = await detectRecurring(db, userId, { minOccurrences: 6 });
        expect(rows).toEqual([]);
    });
});
