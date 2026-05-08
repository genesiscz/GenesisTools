import { describe, expect, it } from "bun:test";
import {
    ShopsAcceptMatchInput,
    ShopsComparePricesInput,
    ShopsCoverageInput,
    ShopsGetProductInput,
    ShopsGetProductInputJsonSchema,
    ShopsIngestInput,
    ShopsListCategoriesInput,
    ShopsMatchProductInput,
    ShopsNotifyAckInput,
    ShopsRecentNotificationsInput,
    ShopsSearchInput,
    ShopsSearchInputJsonSchema,
    ShopsWatchAddInput,
    ShopsWatchListInput,
    ShopsWatchRemoveInput,
} from "./types";

describe("ShopsGetProductInput", () => {
    it("accepts {url}", () => {
        const out = ShopsGetProductInput.parse({ url: "https://www.rohlik.cz/1419780-x" });
        expect(out.url).toBe("https://www.rohlik.cz/1419780-x");
    });

    it("accepts {shop, slug}", () => {
        const out = ShopsGetProductInput.parse({ shop: "rohlik.cz", slug: "1419780" });
        expect(out.shop).toBe("rohlik.cz");
    });

    it("rejects an empty object", () => {
        expect(() => ShopsGetProductInput.parse({})).toThrow();
    });

    it("JSONSchema mirrors the Zod shape", () => {
        const schema = ShopsGetProductInputJsonSchema;
        expect(schema.type).toBe("object");
        expect(schema.properties).toHaveProperty("url");
        expect(schema.properties).toHaveProperty("shop");
        expect(schema.properties).toHaveProperty("slug");
    });
});

describe("ShopsMatchProductInput", () => {
    it("requires url", () => {
        expect(() => ShopsMatchProductInput.parse({})).toThrow();
        const out = ShopsMatchProductInput.parse({ url: "https://www.rohlik.cz/1419780-x" });
        expect(out.url).toBeDefined();
    });
});

describe("ShopsSearchInput", () => {
    it("requires query, allows shop+category+limit", () => {
        const out = ShopsSearchInput.parse({ query: "ritter", shop: "rohlik.cz", limit: 10 });
        expect(out.query).toBe("ritter");
        expect(out.limit).toBe(10);
    });

    it("rejects empty query", () => {
        expect(() => ShopsSearchInput.parse({ query: "" })).toThrow();
    });

    it("clamps limit upper bound and rejects 0", () => {
        expect(() => ShopsSearchInput.parse({ query: "x", limit: 9999 })).toThrow();
        expect(() => ShopsSearchInput.parse({ query: "x", limit: 0 })).toThrow();
    });

    it("JSONSchema requires query and exposes optional fields", () => {
        const s = ShopsSearchInputJsonSchema;
        expect(s.required).toContain("query");
        expect(s.properties).toHaveProperty("shop");
        expect(s.properties).toHaveProperty("category");
        expect(s.properties).toHaveProperty("limit");
    });
});

describe("ShopsListCategoriesInput", () => {
    it("requires shop", () => {
        expect(() => ShopsListCategoriesInput.parse({})).toThrow();
        ShopsListCategoriesInput.parse({ shop: "rohlik.cz" });
    });
});

describe("ShopsComparePricesInput", () => {
    it("requires non-empty masterIds array of integers", () => {
        ShopsComparePricesInput.parse({ masterIds: [1, 2, 3] });
        expect(() => ShopsComparePricesInput.parse({ masterIds: [] })).toThrow();
        expect(() => ShopsComparePricesInput.parse({ masterIds: ["x"] })).toThrow();
    });
});

describe("ShopsCoverageInput / ShopsWatchListInput", () => {
    it("accept empty objects", () => {
        ShopsCoverageInput.parse({});
        ShopsWatchListInput.parse({});
    });
});

describe("ShopsRecentNotificationsInput", () => {
    it("allows optional limit and since", () => {
        ShopsRecentNotificationsInput.parse({});
        ShopsRecentNotificationsInput.parse({ limit: 50 });
        ShopsRecentNotificationsInput.parse({ since: "2026-05-01T00:00:00Z" });
    });

    it("rejects malformed since", () => {
        expect(() => ShopsRecentNotificationsInput.parse({ since: "not-a-date" })).toThrow();
    });
});

describe("write-tool inputs", () => {
    it("validate basic shapes", () => {
        ShopsIngestInput.parse({ url: "https://www.rohlik.cz/1419780-x" });
        ShopsAcceptMatchInput.parse({ productIdA: 1, productIdB: 2 });
        ShopsNotifyAckInput.parse({ id: 5 });
        ShopsWatchRemoveInput.parse({ id: 5 });
        expect(() => ShopsAcceptMatchInput.parse({ productIdA: 1 })).toThrow();
    });
});

describe("ShopsWatchAddInput", () => {
    it("requires url, threshold fields all optional", () => {
        ShopsWatchAddInput.parse({ url: "https://www.rohlik.cz/1419780-x" });
        const full = ShopsWatchAddInput.parse({
            url: "https://www.rohlik.cz/1419780-x",
            target_price: 39.9,
            drop_percent: 0.15,
            drop_absolute: 5,
            restricted_to_shop: "rohlik.cz",
            label: "Coffee",
            cooldown_hours: 12,
        });
        expect(full.cooldown_hours).toBe(12);
    });

    it("rejects negative target_price", () => {
        expect(() => ShopsWatchAddInput.parse({ url: "https://www.rohlik.cz/x", target_price: -1 })).toThrow();
    });

    it("rejects drop_percent outside [0,1]", () => {
        expect(() => ShopsWatchAddInput.parse({ url: "https://www.rohlik.cz/x", drop_percent: 1.5 })).toThrow();
        expect(() => ShopsWatchAddInput.parse({ url: "https://www.rohlik.cz/x", drop_percent: -0.1 })).toThrow();
    });
});
