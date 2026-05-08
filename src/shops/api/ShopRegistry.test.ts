import { describe, expect, it } from "bun:test";
import { ShopRegistry } from "./ShopRegistry";

describe("ShopRegistry", () => {
    it("starts empty (Plan 01: no per-shop clients yet)", () => {
        const r = ShopRegistry.fresh();
        expect(r.all()).toEqual([]);
    });

    it("forShop returns undefined when not registered", () => {
        const r = ShopRegistry.fresh();
        expect(r.forShop("rohlik.cz")).toBeUndefined();
    });

    it("forUrl delegates to @hlidac-shopu/lib shopOrigin and returns undefined for empty registry", () => {
        const r = ShopRegistry.fresh();
        expect(r.forUrl("https://www.rohlik.cz/1419780-ritter-sport")).toBeUndefined();
    });

    it("forUrl returns undefined for an unknown / malformed URL without throwing", () => {
        const r = ShopRegistry.fresh();
        expect(() => r.forUrl("not a url")).not.toThrow();
        expect(r.forUrl("not a url")).toBeUndefined();
    });

    it("ShopRegistry.get() returns a stable singleton", () => {
        const a = ShopRegistry.get();
        const b = ShopRegistry.get();
        expect(a).toBe(b);
    });
});
