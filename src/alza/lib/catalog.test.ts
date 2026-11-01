import { describe, expect, test } from "bun:test";
import {
    ImpersonatedHttpClient,
    type ImpersonatedRequest,
    type ImpersonatedResponse,
} from "@genesiscz/utils/http/impersonate/client";
import { AlzaApi } from "./api";
import {
    cardToSummary,
    categoryListingPath,
    getDeals,
    parseListingCards,
    parsePrice,
    parseReviewDetail,
    productIdFromRef,
    toReview,
} from "./catalog";
import { lowestBeforeLatest } from "./history";
import { findOperation } from "./operations";
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
    PC_CATEGORY_IDS,
    type PcRole,
    type ProductParam,
    parseCzechNumber,
    type RulePart,
} from "./pc-build";
import { parsePcPart } from "./pc-build-format";
import { PcBuilder, type PcCatalog, type Product } from "./pc-build-service";
import { geocodeUrl } from "./pickup";

/** Answers every request from `answer` and records it; never touches the network or the curl worker. */
class CannedHttp extends ImpersonatedHttpClient {
    readonly requests: ImpersonatedRequest[] = [];

    constructor(private readonly answer: (req: ImpersonatedRequest) => ImpersonatedResponse) {
        super({ label: "test" });
    }

    override async request(req: ImpersonatedRequest): Promise<ImpersonatedResponse> {
        this.requests.push(req);
        return this.answer(req);
    }
}

const noNetwork = (req: ImpersonatedRequest): ImpersonatedResponse => {
    throw new Error(`unexpected request in a test: ${req.url}`);
};

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
const MB_AM4_ATX = P([
    ["Socket", "AMD AM4"],
    ["Formát základní desky", "ATX"],
    ["Typ paměti", "DDR4"],
    ["Počet slotů RAM", "4 ×"],
    ["Provedení", "DIMM"],
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

describe("deals", () => {
    test("pages is a page budget, however sparse the discounts are", async () => {
        const card = (id: number) =>
            `<div class="box browsingitem canBuy" data-code="C${id}" data-id="${id}"><a class="name" href="/c-d${id}.htm">Card ${id}</a><span class="ads-pb__price-value">100,-</span></div>`;
        const page = (n: number) =>
            `${Array.from({ length: 24 }, (_, i) => card(n * 100 + i)).join("")}<a href="/18851284-p${n + 1}.htm">${n + 1}</a>`;
        const http = new CannedHttp((req) => {
            const n = Number(/-p(\d+)\.htm/.exec(req.url)?.[1] ?? 1);
            return { status: 200, url: req.url, headers: {}, text: page(n) };
        });
        const api = new AlzaApi({ http });
        const deals = await getDeals(api, { categoryId: 18851284, pages: 2 });
        expect(deals.items).toEqual([]);
        expect(http.requests.map((r) => r.url)).toEqual([
            "https://www.alza.cz/18851284.htm",
            "https://www.alza.cz/18851284-p2.htm",
        ]);
    });
});

describe("price history", () => {
    test("the 30-day low includes the price carried in from before the window", () => {
        const at = (date: string, price: number | null) => ({ date, price, originalPrice: null });
        expect(lowestBeforeLatest([at("2026-12-01", 900), at("2027-01-01", 1000)])).toBe(900);
        expect(lowestBeforeLatest([at("2026-11-01", 700), at("2026-12-01", 900), at("2027-01-01", 1000)])).toBe(900);
        expect(lowestBeforeLatest([at("2026-12-10", 950), at("2026-12-20", 990), at("2027-01-01", 1000)])).toBe(950);
        expect(lowestBeforeLatest([at("2026-12-01", 800), at("2026-12-02", null), at("2027-01-01", 1000)])).toBe(
            undefined
        );
        expect(lowestBeforeLatest([at("2027-01-01", 1000)])).toBeUndefined();
    });
});

describe("pickup geocoding", () => {
    test("a 5-digit postal code is spaced for CZ and SK only", () => {
        expect(geocodeUrl("11000", "cz").searchParams.get("postalcode")).toBe("110 00");
        expect(geocodeUrl("811 01", "sk").searchParams.get("postalcode")).toBe("811 01");
        expect(geocodeUrl("10115", "de").searchParams.get("postalcode")).toBe("10115");
        expect(geocodeUrl("Brno", "cz").searchParams.get("q")).toBe("Brno");
    });
});

describe("pc build: suggest", () => {
    const fake = (products: Record<string, { name: string; price: number; params: ProductParam[] }>) => {
        const reads: string[] = [];
        const listings = new Map<number, string[]>();
        const product = (code: string): Product => ({
            code,
            name: products[code]?.name ?? code,
            url: `https://example.com/${code}`,
            price: products[code]?.price,
            inStock: true,
            params: products[code]?.params,
        });
        const catalog: PcCatalog = {
            getProductSpecs: async (code) => {
                reads.push(code);
                return product(code);
            },
            searchProducts: async ({ categoryId }) => ({
                products: (listings.get(categoryId) ?? []).map((code) => ({ ...product(code), params: undefined })),
            }),
            getCategoryFilters: async () => ({ brands: [] }),
        };
        return { catalog, reads, listings };
    };

    test("fixed parts get the role checks and the duplicate guard of check, within the fetch budget", async () => {
        const { catalog, reads } = fake({ MB1: { name: "Board", price: 3000, params: MB_AM5_ATX } });
        const builder = new PcBuilder(catalog);
        await expect(builder.suggest({ budget: 40000, fixedParts: [{ code: "MB1", role: "cpu" }] })).rejects.toThrow(
            /fixed part MB1: .*looks like a motherboard/
        );
        await expect(
            builder.suggest({ budget: 40000, fixedParts: [{ code: "MB1" }, { code: "MB1" }] })
        ).rejects.toThrow(/listed twice/);
        reads.length = 0;
        await expect(
            builder.suggest({ budget: 40000, maxDetailFetches: 1, fixedParts: [{ code: "MB1" }, { code: "MB2" }] })
        ).rejects.toThrow(/2 fixed parts need 2 product reads/);
        expect(reads).toEqual([]);
    });

    test("an exhausted fetch budget never picks a card that already failed a rule", async () => {
        const { catalog, listings } = fake({
            CPU4: { name: "AMD Ryzen 7 5800X", price: 5000, params: CPU_AM4 },
            MB5: { name: "Board Five", price: 3000, params: MB_AM5_ATX },
            MB4: { name: "Board Four", price: 2500, params: MB_AM4_ATX },
        });
        listings.set(PC_CATEGORY_IDS.motherboard, ["MB5", "MB4"]);
        const report = await new PcBuilder(catalog).suggest({
            budget: 60000,
            maxDetailFetches: 2,
            fixedParts: [{ code: "CPU4" }],
        });
        const board = report.parts.find((p) => p.role === "motherboard");
        expect(board?.code).toBe("MB4");
        expect(board?.specsFetched).toBe(false);
        expect(report.notes.some((n) => n.includes("skipped MB5 (cpu_socket_motherboard failed)"))).toBe(true);
    });

    test("a candidate is checked against a pinned part of a later role", async () => {
        const { catalog, reads, listings } = fake({
            MB4: { name: "Board Four", price: 2500, params: MB_AM4_ATX },
            CPU5: { name: "AMD Ryzen 7 7700", price: 6000, params: CPU_AM5_IGPU },
            CPU4: { name: "AMD Ryzen 7 5800X", price: 5000, params: CPU_AM4 },
        });
        listings.set(PC_CATEGORY_IDS.cpu, ["CPU5", "CPU4"]);
        const report = await new PcBuilder(catalog).suggest({ budget: 60000, fixedParts: [{ code: "MB4" }] });
        expect(reads.slice(0, 3)).toEqual(["MB4", "CPU5", "CPU4"]);
        expect(report.parts.find((p) => p.role === "cpu")?.code).toBe("CPU4");
        expect(report.verdicts.find((v) => v.rule === "cpu_socket_motherboard")?.verdict).toBe("pass");
    });

    test("pc_build_suggest refuses a storefront that does not price in CZK", async () => {
        const api = new AlzaApi({ storefront: "sk", http: new CannedHttp(noNetwork) });
        await expect(findOperation("pc_build_suggest").run(api, { budget: 40000 })).rejects.toThrow(
            /cz storefront only/
        );
    });
});
