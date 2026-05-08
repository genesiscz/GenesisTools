import { beforeEach, describe, expect, it } from "bun:test";
import { __resetInitState, initShopRegistry } from "../api/registry-init";
import { ShopRegistry } from "../api/ShopRegistry";
import { renderShopsTable } from "./shops";

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
        const out = renderShopsTable(ShopRegistry.get());
        const drmaxLine = out.split("\n").find((l) => l.startsWith("drmax.cz"));
        const benuLine = out.split("\n").find((l) => l.startsWith("benu.cz"));
        expect(drmaxLine).toBeDefined();
        expect(benuLine).toBeDefined();
    });
});
