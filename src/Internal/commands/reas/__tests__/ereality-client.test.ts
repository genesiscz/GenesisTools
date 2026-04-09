import { describe, expect, test } from "bun:test";
import { buildErealityUrl, parseErealityHtml } from "@app/Internal/commands/reas/api/ereality-client";

describe("buildErealityUrl", () => {
    test("builds URL for district with page 0", () => {
        const url = buildErealityUrl("hradec-kralove", 0);
        expect(url).toBe("https://www.ereality.cz/pronajem/byty/hradec-kralove?pg=0");
    });

    test("builds URL for district with page 2", () => {
        const url = buildErealityUrl("brno-mesto", 2);
        expect(url).toBe("https://www.ereality.cz/pronajem/byty/brno-mesto?pg=2");
    });
});

describe("parseErealityHtml", () => {
    test("parses listing tiles from HTML", () => {
        const html = `
            <div class="ereality-property-list">
                <div class="d-md-flex ereality-property-tile">
                    <a href="/presmeruj/source/abc123" class="ereality-property-description">
                        <strong class="ereality-property-heading">Pronájem bytu 3+1 68 m²</strong>
                        <p class="ereality-property-locality">Hradec Králové, okres Hradec Králové</p>
                    </a>
                    <div class="ereality-property-price">18 000 Kč/měsíc</div>
                </div>
                <div class="d-md-flex ereality-property-tile">
                    <a href="/presmeruj/source/def456" class="ereality-property-description">
                        <strong class="ereality-property-heading">Pronájem bytu 2+kk 45 m²</strong>
                        <p class="ereality-property-locality">Hradec Králové, okres Hradec Králové</p>
                    </a>
                    <div class="ereality-property-price">12 500 Kč</div>
                </div>
            </div>
        `;

        const listings = parseErealityHtml(html);

        expect(listings).toHaveLength(2);

        expect(listings[0].heading).toBe("Pronájem bytu 3+1 68 m²");
        expect(listings[0].locality).toBe("Hradec Králové, okres Hradec Králové");
        expect(listings[0].price).toBe(18000);
        expect(listings[0].disposition).toBe("3+1");
        expect(listings[0].area).toBe(68);

        expect(listings[1].heading).toBe("Pronájem bytu 2+kk 45 m²");
        expect(listings[1].price).toBe(12500);
        expect(listings[1].disposition).toBe("2+kk");
        expect(listings[1].area).toBe(45);
    });

    test("handles price with various formats", () => {
        const html = `
            <div class="d-md-flex ereality-property-tile">
                <a href="/presmeruj/x/1" class="ereality-property-description">
                    <strong class="ereality-property-heading">Pronájem bytu 1+kk 28 m²</strong>
                    <p class="ereality-property-locality">Praha</p>
                </a>
                <div class="ereality-property-price">8 500 Kč/měsíc</div>
            </div>
        `;

        const listings = parseErealityHtml(html);
        expect(listings).toHaveLength(1);
        expect(listings[0].price).toBe(8500);
    });

    test("returns empty array for no tiles", () => {
        const html = "<div>No listings</div>";
        const listings = parseErealityHtml(html);
        expect(listings).toHaveLength(0);
    });

    test("skips tiles with unparseable price", () => {
        const html = `
            <div class="d-md-flex ereality-property-tile">
                <a href="/presmeruj/x/1" class="ereality-property-description">
                    <strong class="ereality-property-heading">Pronájem bytu 2+1 55 m²</strong>
                    <p class="ereality-property-locality">Brno</p>
                </a>
                <div class="ereality-property-price">Cena na vyžádání</div>
            </div>
        `;

        const listings = parseErealityHtml(html);
        expect(listings).toHaveLength(0);
    });

    test("parses <li> tile elements (current site layout)", () => {
        const html = `
            <ul class="ereality-property-list">
                <li class="d-md-flex ereality-property-tile">
                    <a href="/detail/byt-2-kk-k-pronajmu-praha-3/abc123" class="ereality-property-description">
                        <strong class="ereality-property-heading">Byt 2+kk k pronájmu Praha 3</strong>
                        <p class="ereality-property-locality">Praha 3, okres Hlavní město Praha</p>
                    </a>
                    <div class="ereality-property-price">18 000 Kč</div>
                </li>
                <li class="d-md-flex ereality-property-tile">
                    <a href="/detail/pronajem-bytu-3-kk-75m2/def456" class="ereality-property-description">
                        <strong class="ereality-property-heading">Pronájem bytu 3+kk, 75m2, ul. Italská, Praha 3</strong>
                        <p class="ereality-property-locality">Praha 3, okres Hlavní město Praha</p>
                    </a>
                    <div class="ereality-property-price">25 000 Kč/měsíc</div>
                </li>
            </ul>
        `;

        const listings = parseErealityHtml(html);

        expect(listings).toHaveLength(2);

        // New format: "Byt X+kk k pronájmu" — disposition extracted, area unavailable
        expect(listings[0].disposition).toBe("2+kk");
        expect(listings[0].area).toBe(0);
        expect(listings[0].price).toBe(18000);

        // Old format still in use: "Pronájem bytu X+kk, NNm2"
        expect(listings[1].disposition).toBe("3+kk");
        expect(listings[1].area).toBe(75);
        expect(listings[1].price).toBe(25000);
    });

    test("extracts total count from results header", () => {
        const { extractTotalCount } = require("@app/Internal/commands/reas/api/ErealityClient");
        const html = `
            <h2>Byty k pronájmu <span class="ereality-filter-results-count">
                <small class="text-muted"> &nbsp; (264 inzerátů)</small>
            </span></h2>
        `;

        expect(extractTotalCount(html)).toBe(264);
    });
});
