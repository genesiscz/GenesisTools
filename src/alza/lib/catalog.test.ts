import { describe, expect, test } from "bun:test";
import {
    cardToSummary,
    categoryListingPath,
    parseListingCards,
    parsePrice,
    parseReviewDetail,
    productIdFromRef,
    toReview,
} from "./catalog";
import {
    checkBuild,
    checkCoolerClearance,
    checkCpuSocket,
    checkDisplayOutput,
    checkGpuLength,
    checkMotherboardFormFactor,
    checkPsuFormFactor,
    checkPsuWattage,
    checkRamMotherboard,
    detectRole,
    estimatePower,
    normalizeFormFactor,
    normalizeSocket,
    normalizeSpecs,
    overallVerdict,
    type PcRole,
    type ProductParam,
    parseCzechNumber,
    type RulePart,
} from "./pc-build";
import { parsePcPart } from "./pc-build-format";
import { PcBuilder, type PcCatalog } from "./pc-build-service";

describe("parsePrice", () => {
    test("reads the storefront price formats", () => {
        expect(parsePrice("2 249,-")).toBe(2249);
        expect(parsePrice("1 859 Kč")).toBe(1859);
        expect(parsePrice("149,90 €")).toBe(149.9);
        expect(parsePrice("")).toBeUndefined();
        expect(parsePrice("zdarma")).toBeUndefined();
    });
});

describe("productIdFromRef", () => {
    test("takes an id or a URL and leaves a code to the search", () => {
        expect(productIdFromRef("9383715")).toBe(9383715);
        expect(productIdFromRef("https://www.alza.cz/auto/alcoforce-professional-2-0-d9383715.htm?o=1")).toBe(9383715);
        expect(productIdFromRef("https://www.alza.cz/x?dq=5089794")).toBe(5089794);
        expect(productIdFromRef("AUPR65708")).toBeUndefined();
    });
});

describe("categoryListingPath", () => {
    test("builds the numeric suffix Alza resolves", () => {
        expect(categoryListingPath({ categoryId: 18851284 }, 1)).toBe("/18851284.htm");
        expect(
            categoryListingPath({ categoryId: 18851284, brandId: 15529, params: [{ paramId: 15361, valueId: 239 }] }, 3)
        ).toBe("/18851284-v15529-par15361-239-p3.htm");
    });
});

describe("reviews", () => {
    test("parseReviewDetail splits the date and the variant", () => {
        expect(parseReviewDetail("Hodnoceno 5.09.2026, varianta Tester X")).toEqual({
            date: "2026-09-05",
            variant: "Tester X",
        });
        expect(parseReviewDetail(null)).toEqual({});
    });

    test("toReview keeps the text, the lists and the country", () => {
        const review = toReview({
            rating: 2,
            likeCount: 3,
            description: "  Shows zero after a beer. ",
            positives: ["design"],
            negatives: ["inaccurate"],
            name: "Alice, Brno",
            verifiedPurchase: true,
            reviewDetail: "Hodnoceno 10.06.2026, varianta Tester X",
            isTranslated: false,
            flagUrl: "https://cdn.example.com/images/flags/country/sk.svg",
            images: [],
        });
        expect(review).toMatchObject({
            rating: 2,
            text: "Shows zero after a beer.",
            country: "SK",
            date: "2026-06-10",
        });
        expect(review.cons).toEqual(["inaccurate"]);
    });
});

describe("listing cards", () => {
    test("cardToSummary derives the discount from the struck price", () => {
        const item = cardToSummary(
            {
                id: 1,
                code: "TST001",
                name: "Tester",
                url: "https://www.alza.cz/tester-d1.htm",
                price: "2 249,-",
                cprice: "2 799,-",
                priceNoCurrency: 2249,
                rating: 4.6,
                ratingCount: 98,
                can_buy: true,
                priceInfoV2: { headerText: "BLACK FRIDAY -19 %" },
            },
            "CZK",
            "https://www.alza.cz"
        );
        expect(item).toMatchObject({
            price: 2249,
            originalPrice: 2799,
            discountPercent: 19,
            badge: "BLACK FRIDAY -19 %",
        });
    });

    test("parseListingCards reads the server-rendered cards and the page links", () => {
        const html = `
            <div class="box browsingitem canBuy" data-code="TST001" data-id="11">
                <a class="name" href="/tester-d11.htm">Tester One</a>
                <div class="Description">Electrochemical sensor</div>
                <span class="ads-pb__header">BLACK FRIDAY -24 %</span>
                <span class="ads-pb__price-value">1 899,-</span>
                <span class="ads-pb__original-price">2 499,-</span>
                <span class="star-rating-block__value">4,6</span><span class="star-rating-block__count">1 234×</span>
                <span class="avlVal">Skladem</span>
            </div>
            <div class="box browsingitem" data-code="TST002" data-id="12"><a class="name" href="/t-d12.htm">Tester Two</a></div>
            <a href="/18851284-p2.htm">2</a><a href="/18851284-p3.htm">3</a>`;
        const parsed = parseListingCards(html, "CZK", "https://www.alza.cz");
        expect(parsed.pages).toEqual([2, 3]);
        expect(parsed.items).toHaveLength(2);
        expect(parsed.items[0]).toMatchObject({
            code: "TST001",
            url: "https://www.alza.cz/tester-d11.htm",
            price: 1899,
            originalPrice: 2499,
            discountPercent: 24,
            rating: 4.6,
            ratingCount: 1234,
            inStock: true,
        });
        expect(parsed.items[1].inStock).toBe(false);
    });
});

// ── PC builder rules (fixtures trimmed from lukabudik/alza-mcp-community (MIT) test/pc-build.test.ts) ──

const P = (rows: Array<[string, string]>): ProductParam[] => rows.map(([name, value]) => ({ name, value }));
const CPU_AM4 = P([
    ["Řada procesoru", "AMD Ryzen 7"],
    ["Socket", "AMD AM4"],
    ["Počet jader procesoru", "8 ×"],
    ["Podporovaný typ paměti", "DDR4"],
    ["Typ integrované grafické karty", "Bez integrovaného grafického čipu"],
    ["TDP", "105 W"],
]);
const CPU_AM5_IGPU = P([
    ["Řada procesoru", "AMD Ryzen 7"],
    ["Socket", "AMD AM5"],
    ["Počet jader procesoru", "8 ×"],
    ["Podporovaný typ paměti", "DDR5"],
    ["Typ integrované grafické karty", "AMD Radeon Graphics"],
    ["TDP", "120 W"],
]);
const MB_AM5_ATX = P([
    ["Socket", "AMD AM5"],
    ["Formát základní desky", "ATX"],
    ["Typ paměti", "DDR5"],
    ["Počet slotů RAM", "2 ×"],
    ["Provedení", "DIMM"],
]);
const RAM_DDR5_KIT = P([
    ["Určení", "Pro počítač"],
    ["Provedení", "DIMM"],
    ["Velikost operační paměti RAM", "32 GB"],
    ["Frekvence paměti", "6 000 MHz"],
    ["Typ paměti", "DDR5"],
    ["Počet modulů v balení", "2 ks"],
]);
const RAM_SODIMM = P([
    ["Provedení", "SO-DIMM"],
    ["Typ paměti", "DDR5"],
    ["Počet modulů v balení", "1 ks"],
]);
const GPU_RTX = P([
    ["Šířka", "291,9 mm"],
    ["Výška", "41,3 mm"],
    ["TDP", "180 W"],
]);
const GPU_RADEON = P([
    ["Šířka", "360 mm"],
    ["Doporučený výkon zdroje", "800 W"],
]);
const CASE_H5 = P([
    ["Formát základní desky", "ATX,mATX (Micro ATX),mITX (Mini ITX),eATX (Extended ATX)"],
    ["Max. výška chladiče procesoru", "170 mm"],
    ["Max. délka grafické karty", "410 mm"],
    ["Podporovaný formát zdroje", "ATX"],
    ["Podporovaná velikost radiátoru navrchu", "120mm,240mm,280mm"],
]);
const CASE_SMALL = P([
    ["Formát základní desky", "mATX (Micro ATX),mITX (Mini ITX)"],
    ["Max. výška chladiče procesoru", "150 mm"],
    ["Max. délka grafické karty", "300 mm"],
    ["Podporovaný formát zdroje", "SFX"],
]);
const COOLER_AIR = P([
    ["Chlazení", "Vzduchem"],
    ["AMD Socket", "AM4,AM5"],
    ["Intel Socket", "1700,1851"],
    ["Výška", "155 mm"],
]);
const PSU_850 = P([
    ["Výkon", "850 W"],
    ["Formát", "ATX"],
    ["Certifikace", "80 PLUS Gold"],
]);
const PSU_450 = P([
    ["Výkon", "450 W"],
    ["Formát", "ATX"],
]);
const pcPart = (role: PcRole, code: string, rows: ProductParam[]): RulePart => ({
    code,
    specs: normalizeSpecs(role, rows),
});

describe("pc build: value parsers", () => {
    test("Czech numbers, sockets and form factors", () => {
        expect(parseCzechNumber("291,9 mm")).toBe(291.9);
        expect(parseCzechNumber("1 810 g")).toBe(1810);
        expect(normalizeSocket("Intel 1700")).toBe("LGA1700");
        expect(normalizeSocket("AMD AM5")).toBe("AM5");
        expect(normalizeFormFactor("mATX (Micro ATX)")).toBe("mATX");
    });

    test("normalizeSpecs keeps the Czech row and raw value; a GPU's length is its longest dimension", () => {
        expect(normalizeSpecs("case", CASE_H5).maxGpuLengthMm).toEqual({
            value: 410,
            source: "Max. délka grafické karty",
            raw: "410 mm",
        });
        expect(normalizeSpecs("gpu", GPU_RTX).gpuLengthMm).toMatchObject({ value: 291.9, source: "Šířka" });
        expect(normalizeSpecs("cooler", COOLER_AIR).coolerSockets?.value).toEqual(["AM4", "AM5", "LGA1700", "LGA1851"]);
    });

    test("detectRole reads the spec signature", () => {
        expect(detectRole("AMD Ryzen 7 5800X3D", CPU_AM4)).toBe("cpu");
        expect(detectRole("Kingston FURY 32GB KIT DDR5", RAM_DDR5_KIT)).toBe("ram");
        expect(detectRole("Corsair RM850x", PSU_850)).toBe("psu");
    });
});

describe("pc build: compatibility rules", () => {
    test("socket, RAM and display output", () => {
        const mb = pcPart("motherboard", "M", MB_AM5_ATX);
        expect(checkCpuSocket(pcPart("cpu", "C", CPU_AM5_IGPU), mb).verdict).toBe("pass");
        expect(checkCpuSocket(pcPart("cpu", "C", CPU_AM4), mb).verdict).toBe("fail");
        expect(checkCpuSocket(undefined, mb).verdict).toBe("not_applicable");
        expect(checkRamMotherboard([pcPart("ram", "R", RAM_SODIMM)], mb).verdict).toBe("fail");
        expect(
            checkRamMotherboard([pcPart("ram", "R1", RAM_DDR5_KIT), pcPart("ram", "R2", RAM_DDR5_KIT)], mb).verdict
        ).toBe("fail");
        expect(checkDisplayOutput(pcPart("cpu", "C", CPU_AM4), undefined).verdict).toBe("fail");
        expect(checkDisplayOutput(pcPart("cpu", "C", CPU_AM5_IGPU), undefined).verdict).toBe("pass");
    });

    test("PSU wattage: estimate, headroom and the GPU vendor's recommendation", () => {
        const cpu = pcPart("cpu", "C", CPU_AM5_IGPU);
        const gpu = pcPart("gpu", "G", GPU_RTX);
        expect(estimatePower({ cpu, gpu })).toMatchObject({ cpuW: 162, gpuW: 180, totalW: 417, recommendedPsuW: 550 });
        expect(checkPsuWattage({ cpu, gpu, psu: pcPart("psu", "P", PSU_850) }).verdict).toBe("pass");
        expect(checkPsuWattage({ cpu, gpu, psu: pcPart("psu", "P", PSU_450) }).verdict).toBe("warn");
        const radeon = pcPart("gpu", "G", GPU_RADEON);
        expect(estimatePower({ cpu, gpu: radeon }).recommendedPsuW).toBe(800);
        expect(checkPsuWattage({ cpu, gpu: radeon, psu: pcPart("psu", "P", PSU_450) }).verdict).toBe("fail");
    });

    test("case clearances and form factors", () => {
        const h5 = pcPart("case", "K", CASE_H5);
        const small = pcPart("case", "K", CASE_SMALL);
        expect(checkGpuLength(pcPart("gpu", "G", GPU_RTX), h5).verdict).toBe("pass");
        expect(checkGpuLength(pcPart("gpu", "G", GPU_RADEON), small).verdict).toBe("fail");
        expect(checkCoolerClearance(pcPart("cooler", "A", COOLER_AIR), small).verdict).toBe("fail");
        expect(checkMotherboardFormFactor(pcPart("motherboard", "M", MB_AM5_ATX), small).verdict).toBe("fail");
        expect(checkPsuFormFactor(pcPart("psu", "P", PSU_850), small).verdict).toBe("fail");
    });

    test("checkBuild runs every rule and overallVerdict needs the required roles", () => {
        const good = checkBuild({
            cpu: pcPart("cpu", "C", CPU_AM5_IGPU),
            motherboard: pcPart("motherboard", "M", MB_AM5_ATX),
            ram: [pcPart("ram", "R", RAM_DDR5_KIT)],
            gpu: pcPart("gpu", "G", GPU_RTX),
            case: pcPart("case", "K", CASE_H5),
            cooler: pcPart("cooler", "A", COOLER_AIR),
            psu: pcPart("psu", "P", PSU_850),
        });
        expect(good.every((v) => v.verdict === "pass")).toBe(true);
        expect(overallVerdict(good)).toBe("compatible");
        const partial = checkBuild({ cpu: pcPart("cpu", "C", CPU_AM5_IGPU) });
        expect(overallVerdict(partial, { complete: false })).toBe("no_conflicts_found");
    });

    test("PcBuilder.check reads each part once and refuses two CPUs", async () => {
        const products: Record<string, ProductParam[]> = { CPU1: CPU_AM5_IGPU, CPU2: CPU_AM4, MB1: MB_AM5_ATX };
        const reads: string[] = [];
        const catalog: PcCatalog = {
            getProductSpecs: async (code) => {
                reads.push(code);
                return { code, name: code, url: `https://example.com/${code}`, price: 1000, params: products[code] };
            },
            searchProducts: async () => ({ products: [] }),
            getCategoryFilters: async () => ({ brands: [] }),
        };
        const report = await new PcBuilder(catalog).check({ parts: [{ code: "CPU2" }, { code: "MB1" }] });
        expect(reads).toEqual(["CPU2", "MB1"]);
        expect(report.overall).toBe("incompatible");
        expect(report.missingRoles).toContain("psu");
        await expect(new PcBuilder(catalog).check({ parts: [{ code: "CPU1" }, { code: "CPU2" }] })).rejects.toThrow(
            /Two parts have role cpu/
        );
    });
});

describe("pc build: CLI part syntax", () => {
    test("parsePcPart takes a role only after the last colon", () => {
        expect(parsePcPart("BD750m7b1")).toEqual({ code: "BD750m7b1" });
        expect(parsePcPart("BD750m7b1:psu")).toEqual({ code: "BD750m7b1", role: "psu" });
        expect(parsePcPart("https://www.alza.cz/x-d9383715.htm")).toEqual({
            code: "https://www.alza.cz/x-d9383715.htm",
        });
    });
});
