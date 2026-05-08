import { beforeEach, describe, expect, it } from "bun:test";
import { __resetInitState, initShopRegistry } from "./registry-init";
import { ShopRegistry } from "./ShopRegistry";
import { AlzaClient } from "./shops/AlzaClient";
import { KauflandClient } from "./shops/KauflandClient";
import { KosikClient } from "./shops/KosikClient";
import { RohlikClient } from "./shops/RohlikClient";

describe("registry-init", () => {
    beforeEach(() => {
        ShopRegistry.reset();
        __resetInitState();
    });

    it("registers RohlikClient under rohlik.cz", () => {
        initShopRegistry();
        expect(ShopRegistry.get().forShop("rohlik.cz")).toBeInstanceOf(RohlikClient);
    });

    it("registers KosikClient under kosik.cz", () => {
        initShopRegistry();
        expect(ShopRegistry.get().forShop("kosik.cz")).toBeInstanceOf(KosikClient);
    });

    it("registers KauflandClient under kaufland.cz", () => {
        initShopRegistry();
        expect(ShopRegistry.get().forShop("kaufland.cz")).toBeInstanceOf(KauflandClient);
    });

    it("registers AlzaClient under alza.cz", () => {
        initShopRegistry();
        expect(ShopRegistry.get().forShop("alza.cz")).toBeInstanceOf(AlzaClient);
    });

    it("calling twice is idempotent", () => {
        initShopRegistry();
        initShopRegistry();
        const allRohlik = ShopRegistry.get()
            .all()
            .filter((c) => c.shopOrigin === "rohlik.cz");
        expect(allRohlik.length).toBe(1);
    });
});
