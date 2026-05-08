import { beforeEach, describe, expect, it } from "bun:test";
import { __resetInitState, initShopRegistry } from "./registry-init";
import { ShopRegistry } from "./ShopRegistry";
import { AlzaClient } from "./shops/AlzaClient";
import { BenuClient } from "./shops/BenuClient";
import { DrmaxClient } from "./shops/DrmaxClient";
import { ItescoClient } from "./shops/ItescoClient";
import { KauflandClient } from "./shops/KauflandClient";
import { KnihyDobrovskyClient } from "./shops/KnihyDobrovskyClient";
import { KosikClient } from "./shops/KosikClient";
import { MallClient } from "./shops/MallClient";
import { MountfieldClient } from "./shops/MountfieldClient";
import { NotinoClient } from "./shops/NotinoClient";
import { PilulkaClient } from "./shops/PilulkaClient";
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

    it("registers DrmaxClient under drmax.cz", () => {
        initShopRegistry();
        expect(ShopRegistry.get().forShop("drmax.cz")).toBeInstanceOf(DrmaxClient);
    });

    it("registers NotinoClient under notino.cz", () => {
        initShopRegistry();
        expect(ShopRegistry.get().forShop("notino.cz")).toBeInstanceOf(NotinoClient);
    });

    it("registers BenuClient under benu.cz", () => {
        initShopRegistry();
        expect(ShopRegistry.get().forShop("benu.cz")).toBeInstanceOf(BenuClient);
    });

    it("registers MallClient under mall.cz", () => {
        initShopRegistry();
        expect(ShopRegistry.get().forShop("mall.cz")).toBeInstanceOf(MallClient);
    });

    it("registers MountfieldClient under mountfield.cz", () => {
        initShopRegistry();
        expect(ShopRegistry.get().forShop("mountfield.cz")).toBeInstanceOf(MountfieldClient);
    });

    it("registers ItescoClient under itesco.cz", () => {
        initShopRegistry();
        expect(ShopRegistry.get().forShop("itesco.cz")).toBeInstanceOf(ItescoClient);
    });

    it("itesco.cz declares botProtection='akamai'", () => {
        initShopRegistry();
        const itesco = ShopRegistry.get().forShop("itesco.cz");
        expect(itesco?.capabilities.botProtection).toBe("akamai");
    });

    it("registers PilulkaClient under pilulka.cz", () => {
        initShopRegistry();
        expect(ShopRegistry.get().forShop("pilulka.cz")).toBeInstanceOf(PilulkaClient);
    });

    it("registers KnihyDobrovskyClient under knihydobrovsky.cz", () => {
        initShopRegistry();
        expect(ShopRegistry.get().forShop("knihydobrovsky.cz")).toBeInstanceOf(KnihyDobrovskyClient);
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
