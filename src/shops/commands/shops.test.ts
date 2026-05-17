import { beforeEach, describe, expect, it } from "bun:test";
import { __resetInitState, initShopRegistry } from "@app/shops/api/registry-init";
import { ShopRegistry } from "@app/shops/api/ShopRegistry";
import { renderShopsTable } from "@app/shops/lib/render";

describe("renderShopsTable", () => {
    it("renders just the header + 'no shops' note when registry is empty", () => {
        const r = ShopRegistry.fresh();
        const out = renderShopsTable(r);
        expect(out).toContain("shop");
        expect(out).toContain("live");
        expect(out).toContain("history");
        expect(out).toContain("0 shops registered");
        expect(out).toContain("Plan 03");
    });
});

describe("renderShopsTable (with full registry)", () => {
    beforeEach(() => {
        ShopRegistry.reset();
        __resetInitState();
        initShopRegistry();
    });

    it("includes Phase 3 shops (drmax, benu, itesco)", () => {
        const out = renderShopsTable(ShopRegistry.get());
        expect(out).toContain("drmax.cz");
        expect(out).toContain("benu.cz");
        expect(out).toContain("itesco.cz");
    });

    it("itesco.cz row shows bot-protection 'akamai'", () => {
        const out = renderShopsTable(ShopRegistry.get());
        const itescoLine = out.split("\n").find((l) => l.startsWith("itesco.cz"));
        expect(itescoLine).toBeDefined();
        expect(itescoLine).toContain("akamai");
    });

    it("drmax.cz / benu.cz declare cap_ean=false (no in ean column)", () => {
        const all = ShopRegistry.get().all();
        const drmax = all.find((c) => c.shopOrigin === "drmax.cz");
        const benu = all.find((c) => c.shopOrigin === "benu.cz");
        expect(drmax?.capabilities.ean).toBe(false);
        expect(benu?.capabilities.ean).toBe(false);
    });

    it("includes Phase 9 later shops (alza, notino, mall, mountfield, pilulka, knihydobrovsky, hornbach)", () => {
        const out = renderShopsTable(ShopRegistry.get());
        expect(out).toContain("alza.cz");
        expect(out).toContain("notino.cz");
        expect(out).toContain("mall.cz");
        expect(out).toContain("mountfield.cz");
        expect(out).toContain("pilulka.cz");
        expect(out).toContain("knihydobrovsky.cz");
        expect(out).toContain("hornbach.cz");
    });

    it("alza.cz row shows bot-protection 'akamai' (WebView-driven SPA)", () => {
        const out = renderShopsTable(ShopRegistry.get());
        const alzaLine = out.split("\n").find((l) => l.startsWith("alza.cz"));
        expect(alzaLine).toBeDefined();
        expect(alzaLine).toContain("akamai");
    });

    it("includes Phase 2 shops (lidl, albert, billa, dm, tetadrogerie)", () => {
        const out = renderShopsTable(ShopRegistry.get());
        expect(out).toContain("lidl.cz");
        expect(out).toContain("albert.cz");
        expect(out).toContain("billa.cz");
        expect(out).toContain("dm.cz");
        expect(out).toContain("tetadrogerie.cz");
    });

    it("dm.cz is the only Phase-2 shop with cap_ean=true (gtin field)", () => {
        const all = ShopRegistry.get().all();
        const phase2 = all.filter((c) =>
            ["lidl.cz", "albert.cz", "billa.cz", "dm.cz", "tetadrogerie.cz"].includes(c.shopOrigin)
        );
        const ean = phase2.filter((c) => c.capabilities.ean).map((c) => c.shopOrigin);
        expect(ean).toEqual(["dm.cz"]);
    });

    it("lidl.cz and tetadrogerie.cz declare bot-protection 'soft'", () => {
        const out = renderShopsTable(ShopRegistry.get());
        const lidlLine = out.split("\n").find((l) => l.startsWith("lidl.cz"));
        const tetaLine = out.split("\n").find((l) => l.startsWith("tetadrogerie.cz"));
        expect(lidlLine).toContain("soft");
        expect(tetaLine).toContain("soft");
    });
});
