import { describe, expect, it } from "bun:test";
import { SITEMAP_STRATEGIES } from "./sitemap-strategies";

describe("kosik strategy", () => {
    const k = SITEMAP_STRATEGIES["kosik.cz"];

    it("matches product shard child sitemaps", () => {
        expect(k.isProductChild("https://www.kosik.cz/products_01.xml")).toBe(true);
        expect(k.isProductChild("https://www.kosik.cz/products_42.xml")).toBe(true);
        expect(k.isProductChild("https://www.kosik.cz/categories.xml")).toBe(false);
        expect(k.isProductChild("https://www.kosik.cz/brands.xml")).toBe(false);
    });

    it("matches /pNN-slug product leaf URLs", () => {
        expect(k.isProductLeaf("https://www.kosik.cz/p708210-healthyco")).toBe(true);
        expect(k.isProductLeaf("https://www.kosik.cz/p1000814672-bulka-losos")).toBe(true);
        expect(k.isProductLeaf("https://www.kosik.cz/c1046-uzeniny")).toBe(false);
        expect(k.isProductLeaf("https://www.kosik.cz/")).toBe(false);
    });

    it("extracts slug as `pNNN-...`", () => {
        expect(k.productSlug("https://www.kosik.cz/p708210-healthyco")).toBe("p708210-healthyco");
        expect(k.productSlug("https://www.kosik.cz/p1000814672-bulka-losos-2x70g?utm=x")).toBe(
            "p1000814672-bulka-losos-2x70g"
        );
        expect(k.productSlug("https://www.kosik.cz/")).toBeNull();
    });
});

describe("rohlik strategy", () => {
    const r = SITEMAP_STRATEGIES["rohlik.cz"];

    it("only follows the products shard", () => {
        expect(r.isProductChild("https://www.rohlik.cz/sitemap_products.xml")).toBe(true);
        expect(r.isProductChild("https://www.rohlik.cz/sitemap_brands.xml")).toBe(false);
        expect(r.isProductChild("https://www.rohlik.cz/sitemap_base.xml")).toBe(false);
    });

    it("extracts numeric id slug (matches RohlikClient.toRawProduct)", () => {
        expect(r.productSlug("https://www.rohlik.cz/1296729-nivea-men-black-white")).toBe("1296729");
        expect(r.productSlug("https://www.rohlik.cz/1413362-rohlikuv-chleb-tradicni")).toBe("1413362");
        expect(r.productSlug("https://www.rohlik.cz/c300101000-pekarna")).toBeNull();
    });
});

describe("lidl strategy", () => {
    const l = SITEMAP_STRATEGIES["lidl.cz"];

    it("recurses only into product_sitemap.xml*", () => {
        expect(l.isProductChild("https://www.lidl.cz/p/export/CZ/cs/product_sitemap.xml.gz")).toBe(true);
        expect(l.isProductChild("https://www.lidl.cz/explore/assets/s/pages_cs-CZ_cz.xml.gz")).toBe(false);
        expect(l.isProductChild("https://www.lidl.cz/s/cs-CZ/vyhledavac-prodejen/sitemap.xml")).toBe(false);
    });

    it("extracts numeric slug (LidlClient persists item.code without `p` prefix)", () => {
        expect(l.productSlug("https://www.lidl.cz/p/livarno-elektricky-davkovac-mydla/p100396182")).toBe("100396182");
        expect(l.productSlug("https://www.lidl.cz/p/livarno-elektricky-davkovac-mydla/p100396182?ref=x")).toBe(
            "100396182"
        );
        expect(l.productSlug("https://www.lidl.cz/p/gude-lis-na-ovoce/p100088432007")).toBe("100088432007");
        expect(l.productSlug("https://www.lidl.cz/c/online-shop/s10076329")).toBeNull();
    });
});
