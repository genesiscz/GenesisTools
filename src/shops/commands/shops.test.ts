import { describe, expect, it } from "bun:test";
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
