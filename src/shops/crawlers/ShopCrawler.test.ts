import { describe, expect, it } from "bun:test";
import { ShopApiClient } from "../api/ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "../api/ShopApiClient.types";
import { buildTestDatabase } from "../test-utils/buildTestDatabase";
import { ShopCrawler } from "./ShopCrawler";

class FakeShopClient extends ShopApiClient {
    readonly shopOrigin = "fake.cz";
    readonly displayName = "Fake";
    readonly currency = "CZK";
    readonly capabilities: ShopCapabilities = {
        live: true,
        history: false,
        listing: true,
        ean: false,
        search: false,
        botProtection: "none",
    };
    private readonly products: RawProduct[];

    constructor(products: RawProduct[]) {
        super({ baseUrl: "https://fake.cz", rateLimitPerSecond: 1000 });
        this.products = products;
    }

    async getProduct(): Promise<RawProduct> {
        throw new Error("not used");
    }

    async *listCategory(opts: ListingOptions): AsyncIterable<RawProduct> {
        for (const p of this.products) {
            opts.signal?.throwIfAborted();
            await Bun.sleep(1);
            yield p;
        }
    }

    async listCategories(): Promise<Category[]> {
        return [{ id: "cat-1", name: "Cat 1" }];
    }

    parseUrl(url: string): { shopOrigin: string; slug: string; itemId?: string } {
        return { shopOrigin: "fake.cz", slug: url, itemId: url };
    }
}

class FakeCrawler extends ShopCrawler {
    readonly strategy = "fake-test";
}

function buildRawProduct(slug: string, price: number): RawProduct {
    return {
        shopOrigin: "fake.cz",
        slug,
        itemId: slug,
        url: `https://fake.cz/${slug}`,
        name: `Product ${slug}`,
        currentPrice: price,
        observedAt: new Date(),
        raw: {},
    };
}

describe("ShopCrawler.run", () => {
    it("starts and finishes a crawl_runs row with status=completed", async () => {
        const db = buildTestDatabase();
        try {
            const products = [buildRawProduct("a", 10), buildRawProduct("b", 20)];
            const client = new FakeShopClient(products);
            const crawler = new FakeCrawler(client, db);

            const result = await crawler.run({});

            expect(result.status).toBe("completed");
            expect(result.productsSeen).toBe(2);
            expect(result.productsNew).toBe(2);
            expect(result.pricesRecorded).toBe(2);
            expect(result.crawlRunId).toBeGreaterThan(0);
        } finally {
            db.close();
        }
    });

    it("propagates progress events", async () => {
        const db = buildTestDatabase();
        try {
            const products = [buildRawProduct("a", 10), buildRawProduct("b", 20), buildRawProduct("c", 30)];
            const client = new FakeShopClient(products);
            const crawler = new FakeCrawler(client, db);

            const events: number[] = [];
            await crawler.run({}, (e) => events.push(e.productsSeen));

            expect(events.length).toBeGreaterThan(0);
            expect(events[events.length - 1]).toBe(3);
        } finally {
            db.close();
        }
    });

    it("respects opts.limit and stops with status=completed", async () => {
        const db = buildTestDatabase();
        try {
            const products = Array.from({ length: 100 }, (_, i) => buildRawProduct(`p${i}`, i));
            const client = new FakeShopClient(products);
            const crawler = new FakeCrawler(client, db);

            const result = await crawler.run({ limit: 5 });
            expect(result.productsSeen).toBe(5);
            expect(result.status).toBe("completed");
        } finally {
            db.close();
        }
    });

    it("respects AbortSignal and finalizes as cancelled", async () => {
        const db = buildTestDatabase();
        try {
            const products = Array.from({ length: 50 }, (_, i) => buildRawProduct(`p${i}`, i));
            const client = new FakeShopClient(products);
            const crawler = new FakeCrawler(client, db);
            const ctrl = new AbortController();
            setTimeout(() => ctrl.abort(), 10);

            const result = await crawler.run({ signal: ctrl.signal });
            expect(result.status).toBe("cancelled");
            expect(result.productsSeen).toBeLessThan(50);
        } finally {
            db.close();
        }
    });

    it("marks status=failed when listCategory throws", async () => {
        const db = buildTestDatabase();
        try {
            class BoomClient extends FakeShopClient {
                listCategory(_: ListingOptions): AsyncIterable<RawProduct> {
                    return {
                        [Symbol.asyncIterator]() {
                            return {
                                next(): Promise<IteratorResult<RawProduct>> {
                                    return Promise.reject(new Error("kaboom"));
                                },
                            };
                        },
                    };
                }
            }

            const client = new BoomClient([]);
            const crawler = new FakeCrawler(client, db);

            const result = await crawler.run({});
            expect(result.status).toBe("failed");
            expect(result.error).toContain("kaboom");
        } finally {
            db.close();
        }
    });

    it("writes products with master_product_id NULL and match_method='pending'", async () => {
        const db = buildTestDatabase();
        try {
            const products = [buildRawProduct("a", 10), buildRawProduct("b", 20)];
            const client = new FakeShopClient(products);
            const crawler = new FakeCrawler(client, db);

            await crawler.run({});

            const rows = db
                .raw()
                .query<{ master_product_id: number | null; match_method: string }, []>(
                    "SELECT master_product_id, match_method FROM products WHERE shop_origin='fake.cz'"
                )
                .all();
            expect(rows.length).toBe(2);
            expect(rows.every((r) => r.master_product_id === null)).toBe(true);
            expect(rows.every((r) => r.match_method === "pending")).toBe(true);
        } finally {
            db.close();
        }
    });

    it("increments crawl_runs counters", async () => {
        const db = buildTestDatabase();
        try {
            const products = [buildRawProduct("a", 10), buildRawProduct("b", 20)];
            const client = new FakeShopClient(products);
            const crawler = new FakeCrawler(client, db);

            const result = await crawler.run({});

            const row = db
                .raw()
                .query<{ products_seen: number; products_new: number; prices_recorded: number }, [number]>(
                    "SELECT products_seen, products_new, prices_recorded FROM crawl_runs WHERE id = ?"
                )
                .get(result.crawlRunId);
            expect(row?.products_seen).toBe(2);
            expect(row?.products_new).toBe(2);
            expect(row?.prices_recorded).toBe(2);
        } finally {
            db.close();
        }
    });
});
