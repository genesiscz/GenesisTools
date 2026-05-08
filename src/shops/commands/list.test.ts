import { describe, expect, it } from "bun:test";
import type { RawProduct } from "../api/ShopApiClient.types";
import { buildTestDatabase } from "../test-utils/buildTestDatabase";
import { runListCommand } from "./list";

async function seed(): Promise<{ db: ReturnType<typeof buildTestDatabase> }> {
    const db = buildTestDatabase();
    const products: RawProduct[] = [
        {
            shopOrigin: "rohlik.cz",
            slug: "1",
            itemId: "1",
            url: "https://www.rohlik.cz/1-rohlik-zlaty",
            name: "Rohlík zlatý",
            brand: "Rohlík",
            currentPrice: 5,
            observedAt: new Date(),
            raw: {},
        },
        {
            shopOrigin: "rohlik.cz",
            slug: "2",
            itemId: "2",
            url: "https://www.rohlik.cz/2-mleko-150ml",
            name: "Mléko 150ml",
            brand: "Madeta",
            currentPrice: 30,
            observedAt: new Date(),
            raw: {},
        },
    ];
    for (const p of products) {
        const u = await db.upsertProductPending(p);
        await db.recordPrice({
            product_id: u.id,
            observed_at: p.observedAt.toISOString(),
            current_price: p.currentPrice ?? null,
            original_price: null,
            in_stock: null,
            source: "test",
            raw_json: null,
        });
    }

    return { db };
}

describe("runListCommand", () => {
    it("lists all products for a shop", async () => {
        const { db } = await seed();
        try {
            const rows = await runListCommand({ shop: "rohlik.cz", limit: 100, db });
            expect(rows.length).toBe(2);
        } finally {
            db.close();
        }
    });

    it("respects --limit", async () => {
        const { db } = await seed();
        try {
            const rows = await runListCommand({ shop: "rohlik.cz", limit: 1, db });
            expect(rows.length).toBe(1);
        } finally {
            db.close();
        }
    });

    it("filters with --search using FTS5 (diacritic-insensitive)", async () => {
        const { db } = await seed();
        try {
            const rows = await runListCommand({ shop: "rohlik.cz", limit: 50, search: "mleko", db });
            expect(rows.length).toBe(1);
            expect(rows[0].name).toContain("Mléko");
        } finally {
            db.close();
        }
    });

    it("returns [] for unknown shop", async () => {
        const { db } = await seed();
        try {
            const rows = await runListCommand({ shop: "unknown.cz", limit: 50, db });
            expect(rows.length).toBe(0);
        } finally {
            db.close();
        }
    });
});
