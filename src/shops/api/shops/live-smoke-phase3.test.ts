import { describe, expect, it } from "bun:test";
import { BenuClient } from "@app/shops/api/shops/BenuClient";
import { DrmaxClient } from "@app/shops/api/shops/DrmaxClient";
import { ItescoClient } from "@app/shops/api/shops/ItescoClient";

const RUN_BASE = process.env.SHOPS_LIVE_SMOKE === "1";
const RUN_ITESCO = process.env.SHOPS_LIVE_ITESCO === "1";
const maybeBase = RUN_BASE ? describe : describe.skip;
const maybeItesco = RUN_BASE && RUN_ITESCO ? describe : describe.skip;

maybeBase("DrmaxClient live smoke (SHOPS_LIVE_SMOKE=1)", () => {
    it("listCategories returns >0 categories from real sitemap", async () => {
        const client = new DrmaxClient({ rateLimitPerSecond: 1 });
        const cats = await client.listCategories();
        expect(cats.length).toBeGreaterThan(0);
    }, 60_000);

    it("listCategory yields >= 1 product from the first category (limit=3)", async () => {
        const client = new DrmaxClient({ rateLimitPerSecond: 1 });
        const cats = await client.listCategories();
        expect(cats.length).toBeGreaterThan(0);
        let count = 0;
        for await (const p of client.listCategory({ category: cats[0]!.url ?? cats[0]!.id, limit: 3 })) {
            expect(p.shopOrigin).toBe("drmax.cz");
            expect(p.name).toBeTruthy();
            count++;
            if (count >= 3) {
                break;
            }
        }

        expect(count).toBeGreaterThan(0);
    }, 60_000);
});

maybeBase("BenuClient live smoke (SHOPS_LIVE_SMOKE=1)", () => {
    it("listCategories returns >0 categories", async () => {
        const client = new BenuClient({ rateLimitPerSecond: 1 });
        const cats = await client.listCategories();
        expect(cats.length).toBeGreaterThan(0);
    }, 60_000);

    it("listCategory yields >= 1 product from the first category (limit=3)", async () => {
        const client = new BenuClient({ rateLimitPerSecond: 1 });
        const cats = await client.listCategories();
        expect(cats.length).toBeGreaterThan(0);
        let count = 0;
        for await (const p of client.listCategory({ category: cats[0]!.url ?? cats[0]!.id, limit: 3 })) {
            expect(p.shopOrigin).toBe("benu.cz");
            expect(p.name).toBeTruthy();
            count++;
            if (count >= 3) {
                break;
            }
        }

        expect(count).toBeGreaterThan(0);
    }, 60_000);
});

maybeItesco("ItescoClient live smoke (SHOPS_LIVE_SMOKE=1 + SHOPS_LIVE_ITESCO=1)", () => {
    it("listCategories from homepage walk returns superdepartment URLs", async () => {
        const client = new ItescoClient({ rateLimitPerSecond: 0.5 });
        const cats = await client.listCategories();
        expect(cats.length).toBeGreaterThan(0);
    }, 120_000);

    it("listCategory yields up to 5 products at 0.5 req/s", async () => {
        const client = new ItescoClient({ rateLimitPerSecond: 0.5 });
        const cats = await client.listCategories();
        expect(cats.length).toBeGreaterThan(0);
        let count = 0;
        for await (const p of client.listCategory({ category: cats[0]!.url ?? cats[0]!.id, limit: 5 })) {
            expect(p.shopOrigin).toBe("itesco.cz");
            expect(p.url).toContain("nakup.itesco.cz");
            expect(p.name).toBeTruthy();
            count++;
            if (count >= 5) {
                break;
            }
        }

        expect(count).toBeGreaterThan(0);
    }, 180_000);
});
