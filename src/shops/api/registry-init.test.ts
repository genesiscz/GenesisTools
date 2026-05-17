import { beforeEach, describe, expect, it } from "bun:test";
import { __resetInitState, initShopRegistry } from "@app/shops/api/registry-init";
import { ShopRegistry } from "@app/shops/api/ShopRegistry";
import { AlzaClient } from "@app/shops/api/shops/AlzaClient";
import { BenuClient } from "@app/shops/api/shops/BenuClient";
import { DrmaxClient } from "@app/shops/api/shops/DrmaxClient";
import { HornbachClient } from "@app/shops/api/shops/HornbachClient";
import { ItescoClient } from "@app/shops/api/shops/ItescoClient";
import { KauflandClient } from "@app/shops/api/shops/KauflandClient";
import { KnihyDobrovskyClient } from "@app/shops/api/shops/KnihyDobrovskyClient";
import { KosikClient } from "@app/shops/api/shops/KosikClient";
import { MallClient } from "@app/shops/api/shops/MallClient";
import { MojaDmClient } from "@app/shops/api/shops/MojaDmClient";
import { MountfieldClient } from "@app/shops/api/shops/MountfieldClient";
import { NotinoClient } from "@app/shops/api/shops/NotinoClient";
import { PilulkaClient } from "@app/shops/api/shops/PilulkaClient";
import { RohlikClient } from "@app/shops/api/shops/RohlikClient";

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

    it("registers HornbachClient under hornbach.cz", () => {
        initShopRegistry();
        expect(ShopRegistry.get().forShop("hornbach.cz")).toBeInstanceOf(HornbachClient);
    });

    it("registers MojaDmClient under mojadm.sk", () => {
        initShopRegistry();
        expect(ShopRegistry.get().forShop("mojadm.sk")).toBeInstanceOf(MojaDmClient);
    });

    it("calling twice is idempotent", () => {
        initShopRegistry();
        const c1 = ShopRegistry.get().forShop("rohlik.cz");
        initShopRegistry();
        const c2 = ShopRegistry.get().forShop("rohlik.cz");
        const allRohlik = ShopRegistry.get()
            .all()
            .filter((c) => c.shopOrigin === "rohlik.cz");
        expect(allRohlik.length).toBe(1);
        // Instance identity: second init must NOT replace the registered client
        // — the same object reference is preserved across calls.
        expect(c1).toBe(c2);
    });
});
