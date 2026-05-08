import { describe, expect, it } from "bun:test";
import { KosikClient } from "./KosikClient";
import { RohlikClient } from "./RohlikClient";

const RUN_LIVE = process.env.SHOPS_LIVE_SMOKE === "1";
const maybe = RUN_LIVE ? describe : describe.skip;

maybe("RohlikClient live smoke (SHOPS_LIVE_SMOKE=1)", () => {
    it("listCategories returns >0 categories from real API", async () => {
        const client = new RohlikClient({ rateLimitPerSecond: 1 });
        const cats = await client.listCategories();
        expect(cats.length).toBeGreaterThan(0);
    }, 30_000);
});

maybe("KosikClient live smoke (SHOPS_LIVE_SMOKE=1)", () => {
    it("listCategories returns >0 categories from real API", async () => {
        const client = new KosikClient({ rateLimitPerSecond: 1 });
        const cats = await client.listCategories();
        expect(cats.length).toBeGreaterThan(0);
    }, 30_000);
});
