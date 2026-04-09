import { describe, expect, test } from "bun:test";
import type { ProviderBrowseLink } from "@app/Internal/commands/reas/lib/url-builder";
import { buildProviderBrowseLinks, detectProviderFromUrl } from "@app/Internal/commands/reas/lib/url-builder";

describe("url-builder", () => {
    test("detects provider from listing url", () => {
        expect(detectProviderFromUrl("https://www.sreality.cz/detail/pronajem/byt/praha-2/123")).toBe("sreality");
        expect(detectProviderFromUrl("https://www.bezrealitky.cz/nemovitosti-byty-domy/detail")).toBe("bezrealitky");
        expect(detectProviderFromUrl("https://www.ereality.cz/pronajem/byty/praha-2/abc")).toBe("ereality");
        expect(detectProviderFromUrl("https://reas.cz/")).toBe("reas");
    });

    test("prefers the stored listing url for the matching provider", () => {
        const links = buildProviderBrowseLinks({
            district: "Praha 2",
            listingUrl: "https://www.sreality.cz/detail/pronajem/byt/praha-2/123",
            providers: ["sreality", "bezrealitky"],
        });

        expect(links[0]).toEqual({
            provider: "sreality",
            label: "Sreality listing",
            kind: "listing",
            url: "https://www.sreality.cz/detail/pronajem/byt/praha-2/123",
        });
        expect(links[1]?.kind).toBe("search");
    });

    test("builds district browse links for supported providers", () => {
        const links = buildProviderBrowseLinks({
            district: "Hradec Králové",
            providers: ["sreality", "bezrealitky", "ereality", "mf"],
        });

        expect(links.map((link: ProviderBrowseLink) => link.provider)).toEqual([
            "sreality",
            "bezrealitky",
            "ereality",
            "mf",
        ]);
        expect(links[0]?.url).toContain("hradec-kralove");
        expect(links[1]?.url).toContain("Hradec%20Kr%C3%A1lov%C3%A9");
        expect(links[2]?.url).toBe("https://www.ereality.cz/pronajem/byty/hradec-kralove?pg=0");
    });
});
