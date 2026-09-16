import { describe, expect, test } from "bun:test";
import {
    buildErealityUrl as buildErealityUrlFromClassModule,
    ErealityClient,
    parseErealityHtml as parseErealityHtmlFromClassModule,
} from "@app/Internal/commands/reas/api/ErealityClient";
import { buildErealityUrl, parseErealityHtml } from "@app/Internal/commands/reas/api/ereality-client";
import {
    getLatestMfUrl as getLatestMfUrlFromClassModule,
    MfRentalClient,
    parseMfWorkbook,
} from "@app/Internal/commands/reas/api/MfRentalClient";
import { getLatestMfUrl } from "@app/Internal/commands/reas/api/mf-rental";
import { buildReasQueryParams, ReasClient } from "@app/Internal/commands/reas/api/ReasClient";
import type { AnalysisFilters, DateRange } from "@app/Internal/commands/reas/types";
import * as XLSX from "xlsx";

describe("provider refactor compatibility", () => {
    test("keeps ereality helper exports aligned with the class module", () => {
        const html = `
            <div class="d-md-flex ereality-property-tile">
                <a href="/presmeruj/source/abc123" class="ereality-property-description">
                    <strong class="ereality-property-heading">Pronájem bytu 3+1 68 m²</strong>
                    <p class="ereality-property-locality">Hradec Králové</p>
                </a>
                <div class="ereality-property-price">18 000 Kč/měsíc</div>
            </div>
        `;

        const client = new ErealityClient();

        expect(buildErealityUrl("hradec-kralove", 0)).toBe(buildErealityUrlFromClassModule("hradec-kralove", 0));
        expect(client.buildUrl("hradec-kralove", 0)).toBe(buildErealityUrl("hradec-kralove", 0));
        expect(parseErealityHtml(html)).toEqual(parseErealityHtmlFromClassModule(html));
        expect(client.parseHtml(html)).toEqual(parseErealityHtml(html));
    });

    test("exposes deterministic MF URL helper from both modules", () => {
        const januaryDate = new Date("2026-01-10T00:00:00.000Z");
        const client = new MfRentalClient();

        expect(getLatestMfUrl(januaryDate)).toBe("https://mf.gov.cz/assets/attachments/2025-11-15_Cenova-mapa.xlsx");
        expect(getLatestMfUrl(januaryDate)).toBe(getLatestMfUrlFromClassModule(januaryDate));
        expect(client.getLatestUrl(januaryDate)).toBe(getLatestMfUrl(januaryDate));
    });

    test("builds REAS query params through the class module", () => {
        const filters: AnalysisFilters = {
            estateType: "flat",
            constructionType: "panel",
            district: {
                name: "Praha",
                reasId: 3100,
                srealityId: 1,
                srealityLocality: "district",
            },
            disposition: "2+kk",
            periods: [],
        };
        const dateRange: DateRange = {
            label: "Q1",
            from: new Date("2025-01-01T00:00:00.000Z"),
            to: new Date("2025-03-31T23:59:59.999Z"),
        };
        const client = new ReasClient();
        const params = buildReasQueryParams(filters, dateRange);

        expect(params.get("estateTypes")).toBe('["flat"]');
        expect(params.get("constructionType")).toBe('["panel"]');
        expect(params.get("clientId")).toBe("6988cb437c5b9d2963280369");
        expect(params.get("linkedToTransfer")).toBe("true");
        expect(params.get("locality")).toBe('{"districtId":3100}');
        expect(client.buildQueryParams(filters, dateRange).toString()).toBe(params.toString());
    });
});

describe("parseMfWorkbook", () => {
    test("returns priced VK rows for the matching municipality from a Cenova mapa sheet", () => {
        const matching = Array.from({ length: 26 });
        matching[1] = "Vinohrady";
        matching[2] = "Praha 3";
        matching[5] = 185;
        matching[6] = 10;
        matching[7] = 20;
        matching[8] = 30;
        matching[11] = 40;
        matching[12] = 50;
        matching[25] = 200;

        const other = Array.from({ length: 6 });
        other[1] = "Jinde";
        other[2] = "Other Town";
        other[5] = 999;

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["ignore"]]), "Ignore me");
        XLSX.utils.book_append_sheet(
            wb,
            XLSX.utils.aoa_to_sheet([["", "katastr", "obec"], matching, other]),
            "Cenova mapa"
        );
        const buffer = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));

        expect(parseMfWorkbook(buffer, "praha 3")).toEqual([
            {
                cadastralUnit: "Vinohrady",
                municipality: "Praha 3",
                sizeCategory: "VK1",
                referencePrice: 185,
                confidenceMin: 10,
                confidenceMax: 20,
                median: 40,
                newBuildPrice: 30,
                coverageScore: 50,
            },
            {
                cadastralUnit: "Vinohrady",
                municipality: "Praha 3",
                sizeCategory: "VK3",
                referencePrice: 200,
                confidenceMin: 0,
                confidenceMax: 0,
                median: 0,
                newBuildPrice: 0,
                coverageScore: 0,
            },
        ]);
    });

    test("throws when the Cenov sheet has no range", () => {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, {}, "Cenova mapa");
        const buffer = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));

        expect(() => parseMfWorkbook(buffer, "Praha 3")).toThrow('MF XLSX: sheet "Cenova mapa" is empty or missing');
    });
});
