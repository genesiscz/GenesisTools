/**
 * Env-gated drift detector for Phase 2 shops. Skipped on every CI run.
 * Run with: RUN_LIVE_SMOKE=1 bun test src/shops/api/shops/live-smoke-phase2.test.ts
 *
 * Detects upstream API breakage:
 *   - Albert hash rotation (PersistedQueryNotFound)
 *   - Lidl bot protection tightening (HTML instead of JSON)
 *   - Teta auth/CORS tightening
 *   - dm category-search redirect changes
 *   - Billa private API path changes
 */

import { describe, expect, it } from "bun:test";
import logger from "@app/logger";
import { __resetInitState, initShopRegistry } from "../registry-init";
import { ShopRegistry } from "../ShopRegistry";

const log = logger.child({ component: "live-smoke-phase2" });
const RUN = process.env.RUN_LIVE_SMOKE === "1";
const PHASE_2_SHOPS = ["lidl.cz", "albert.cz", "billa.cz", "dm.cz", "tetadrogerie.cz"] as const;

if (RUN) {
    ShopRegistry.reset();
    __resetInitState();
    initShopRegistry();
}

const it_ = RUN ? it : it.skip;

describe("Phase 2 live-smoke (RUN_LIVE_SMOKE=1)", () => {
    for (const origin of PHASE_2_SHOPS) {
        describe(origin, () => {
            it_(
                "listCategories returns at least 1 category",
                async () => {
                    const client = ShopRegistry.get().forShop(origin);
                    expect(client).toBeDefined();
                    if (!client) {
                        return;
                    }

                    const cats = await client.listCategories();
                    log.info({ shop: origin, count: cats.length }, "live: listCategories");
                    expect(cats.length).toBeGreaterThan(0);
                },
                60_000
            );

            it_(
                "listCategory yields at least 1 product on the first category",
                async () => {
                    const client = ShopRegistry.get().forShop(origin);
                    expect(client).toBeDefined();
                    if (!client) {
                        return;
                    }

                    const cats = await client.listCategories();
                    const first = cats[0];
                    expect(first).toBeDefined();
                    if (!first) {
                        return;
                    }

                    let count = 0;
                    for await (const product of client.listCategory({ category: first.id, limit: 5 })) {
                        expect(product.shopOrigin).toBe(origin);
                        expect(product.name).toBeTruthy();
                        expect(typeof product.url).toBe("string");
                        count++;
                        if (count >= 5) {
                            break;
                        }
                    }

                    log.info({ shop: origin, sampled: count }, "live: listCategory");
                    expect(count).toBeGreaterThan(0);
                },
                60_000
            );
        });
    }

    describe("AlbertClient persisted-query freshness", () => {
        it_(
            "LeftHandNavigationBar does not return PersistedQueryNotFound",
            async () => {
                const client = ShopRegistry.get().forShop("albert.cz");
                expect(client).toBeDefined();
                if (!client) {
                    return;
                }

                const cats = await client.listCategories();
                // If the call returned PersistedQueryNotFound, AlbertClient throws — surfaces as test failure.
                expect(cats.length).toBeGreaterThan(0);
            },
            30_000
        );
    });
});
