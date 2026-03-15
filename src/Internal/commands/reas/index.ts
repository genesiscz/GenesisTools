import { stripAnsi } from "@app/utils/string";
import { formatTable } from "@app/utils/table";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { analyzeComparables } from "./analysis/comparables";
import { analyzeDiscount } from "./analysis/discount";
import { analyzeRentalYield } from "./analysis/rental-yield";
import { renderReport } from "./analysis/report";
import { analyzeTimeOnMarket } from "./analysis/time-on-market";
import { analyzeTrends } from "./analysis/trends";
import { fetchMfRentalData } from "./api/mf-rental";
import { fetchSoldListings } from "./api/reas-client";
import { fetchRentalListings } from "./api/sreality-client";
import { clearCache } from "./cache/index";
import type { AnalysisFilters, DateRange, ReasListing, TargetProperty } from "./types";

interface ReasOptions {
    district?: string;
    type?: string;
    disposition?: string;
    periods?: string;
    price?: string;
    area?: string;
    rent?: string;
    monthlyCosts?: string;
    output?: string;
    refresh?: boolean;
    search?: string;
}

interface DistrictInfo {
    name: string;
    reasId: number;
    srealityId: number;
}

const DISTRICTS: Record<string, DistrictInfo> = {
    "Hradec Králové": { name: "Hradec Králové", reasId: 3602, srealityId: 28 },
    Praha: { name: "Praha", reasId: 3100, srealityId: 1 },
    Brno: { name: "Brno", reasId: 3602, srealityId: 4 },
};

const DISTRICT_OPTIONS: Array<{ value: DistrictInfo; label: string }> = [
    { value: DISTRICTS["Hradec Králové"], label: "Hradec Králové" },
    { value: DISTRICTS.Praha, label: "Praha" },
    { value: DISTRICTS.Brno, label: "Brno" },
];

const PROPERTY_TYPES: Array<{ value: string; label: string }> = [
    { value: "panel", label: "Panel" },
    { value: "brick", label: "Brick" },
    { value: "house", label: "House" },
];

const DISPOSITIONS: Array<{ value: string; label: string }> = [
    { value: "1+1", label: "1+1" },
    { value: "1+kk", label: "1+kk" },
    { value: "2+1", label: "2+1" },
    { value: "2+kk", label: "2+kk" },
    { value: "3+1", label: "3+1" },
    { value: "3+kk", label: "3+kk" },
    { value: "4+1", label: "4+1" },
    { value: "4+kk", label: "4+kk" },
    { value: "all", label: "All" },
];

const PERIOD_OPTIONS: Array<{ value: string; label: string }> = [
    { value: "2025", label: "2025" },
    { value: "2024", label: "2024" },
    { value: "2023", label: "2023" },
    { value: "last6m", label: "Last 6 months" },
];

function parsePeriod(period: string): DateRange {
    const relativeMatch = /^last(\d+)m$/i.exec(period);

    if (relativeMatch) {
        const months = parseInt(relativeMatch[1], 10);
        const now = new Date();
        const from = new Date(now);
        from.setMonth(from.getMonth() - months);

        return {
            label: `Last ${months} months`,
            from,
            to: now,
        };
    }

    const year = parseInt(period, 10);

    if (Number.isNaN(year)) {
        throw new Error(`Invalid period: "${period}". Expected a year (e.g. 2024), "last6m", "last12m", etc.`);
    }

    return {
        label: String(year),
        from: new Date(`${year}-01-01T00:00:00`),
        to: new Date(`${year}-12-31T23:59:59`),
    };
}

function parsePeriods(periodsStr: string | undefined): DateRange[] {
    if (!periodsStr) {
        const currentYear = new Date().getFullYear();
        return [parsePeriod(String(currentYear))];
    }

    return periodsStr.split(",").map((s) => parsePeriod(s.trim()));
}

function resolveDistrict(name: string): DistrictInfo {
    const match = Object.entries(DISTRICTS).find(([key]) => key.toLowerCase() === name.toLowerCase());

    if (!match) {
        const available = Object.keys(DISTRICTS).join(", ");
        throw new Error(`Unknown district: "${name}". Available: ${available}`);
    }

    return match[1];
}

function hasSufficientFlags(options: ReasOptions): boolean {
    return !!(options.district && options.type && options.price && options.area);
}

async function runInteractiveWizard(): Promise<{ filters: AnalysisFilters; target: TargetProperty; refresh: boolean }> {
    p.intro(pc.cyan(pc.bold("REAS Investment Analyzer")));

    const district = await p.select({
        message: "Select district",
        options: DISTRICT_OPTIONS,
    });

    if (p.isCancel(district)) {
        p.cancel("Operation cancelled.");
        process.exit(0);
    }

    const propertyType = await p.select({
        message: "Property type",
        options: PROPERTY_TYPES,
    });

    if (p.isCancel(propertyType)) {
        p.cancel("Operation cancelled.");
        process.exit(0);
    }

    const disposition = await p.select({
        message: "Disposition",
        options: DISPOSITIONS,
    });

    if (p.isCancel(disposition)) {
        p.cancel("Operation cancelled.");
        process.exit(0);
    }

    const periods = await p.multiselect({
        message: "Select periods to analyze",
        options: PERIOD_OPTIONS,
        required: true,
    });

    if (p.isCancel(periods)) {
        p.cancel("Operation cancelled.");
        process.exit(0);
    }

    const price = await p.text({
        message: "Target property price (CZK)",
        validate: (val) => {
            if (!val || Number.isNaN(Number(val))) {
                return "Please enter a valid number";
            }
        },
    });

    if (p.isCancel(price)) {
        p.cancel("Operation cancelled.");
        process.exit(0);
    }

    const area = await p.text({
        message: "Target property area (m²)",
        validate: (val) => {
            if (!val || Number.isNaN(Number(val))) {
                return "Please enter a valid number";
            }
        },
    });

    if (p.isCancel(area)) {
        p.cancel("Operation cancelled.");
        process.exit(0);
    }

    const rent = await p.text({
        message: "Expected monthly rent (CZK)",
        validate: (val) => {
            if (!val || Number.isNaN(Number(val))) {
                return "Please enter a valid number";
            }
        },
    });

    if (p.isCancel(rent)) {
        p.cancel("Operation cancelled.");
        process.exit(0);
    }

    const monthlyCosts = await p.text({
        message: "Monthly costs / fond oprav + utilities (CZK)",
        validate: (val) => {
            if (!val || Number.isNaN(Number(val))) {
                return "Please enter a valid number";
            }
        },
    });

    if (p.isCancel(monthlyCosts)) {
        p.cancel("Operation cancelled.");
        process.exit(0);
    }

    const parsedDisposition = disposition === "all" ? undefined : disposition;
    const dateRanges = periods.map((period) => parsePeriod(period));

    const filters: AnalysisFilters = {
        estateType: "flat",
        constructionType: propertyType,
        disposition: parsedDisposition,
        periods: dateRanges,
        district: district,
    };

    const target: TargetProperty = {
        price: Number(price),
        area: Number(area),
        disposition: parsedDisposition ?? "all",
        constructionType: propertyType,
        monthlyRent: Number(rent),
        monthlyCosts: Number(monthlyCosts),
        district: district.name,
        districtId: district.reasId,
        srealityDistrictId: district.srealityId,
    };

    return { filters, target, refresh: false };
}

function buildFromFlags(options: ReasOptions): { filters: AnalysisFilters; target: TargetProperty } {
    const district = resolveDistrict(options.district!);
    const constructionType = options.type!;
    const disposition = options.disposition && options.disposition !== "all" ? options.disposition : undefined;
    const dateRanges = parsePeriods(options.periods);

    const filters: AnalysisFilters = {
        estateType: "flat",
        constructionType,
        disposition,
        periods: dateRanges,
        district,
    };

    const target: TargetProperty = {
        price: Number(options.price),
        area: Number(options.area),
        disposition: disposition ?? "all",
        constructionType,
        monthlyRent: Number(options.rent ?? "0"),
        monthlyCosts: Number(options.monthlyCosts ?? "0"),
        district: district.name,
        districtId: district.reasId,
        srealityDistrictId: district.srealityId,
    };

    return { filters, target };
}

async function fetchAndAnalyze(
    filters: AnalysisFilters,
    target: TargetProperty,
    refresh: boolean,
    outputPath?: string
): Promise<void> {
    const spinner = p.spinner();
    spinner.start("Fetching sold data from reas.cz...");

    const allListings: ReasListing[] = [];

    for (const period of filters.periods) {
        const listings = await fetchSoldListings(filters, period, refresh);
        allListings.push(...listings);
    }

    spinner.message(`Found ${allListings.length} sold listings. Fetching rental data from sreality.cz...`);

    const rentalListings = await fetchRentalListings(filters, refresh);

    spinner.message(`Found ${rentalListings.length} rentals. Loading MF rental benchmarks...`);

    const mfBenchmarks = await fetchMfRentalData(filters.district.name, refresh);

    spinner.stop(
        `Data fetched: ${allListings.length} sold, ${rentalListings.length} rentals, ${mfBenchmarks.length} MF benchmarks.`
    );

    const comparables = analyzeComparables(allListings, target);
    const trends = analyzeTrends(allListings);
    const timeOnMarket = analyzeTimeOnMarket(allListings);
    const discount = analyzeDiscount(allListings);

    const matchingRentals = rentalListings.filter((r) => !filters.disposition || r.disposition === filters.disposition);

    const avgRent =
        matchingRentals.length > 0
            ? matchingRentals.reduce((sum, r) => sum + r.price, 0) / matchingRentals.length
            : target.monthlyRent;

    const yieldResult = analyzeRentalYield(target, comparables.pricePerM2.median, avgRent);

    const report = renderReport({
        comparables,
        trends,
        yield: yieldResult,
        timeOnMarket,
        discount,
        rentalListings,
        mfBenchmarks,
        target,
        filters,
    });

    console.log(report);

    if (outputPath) {
        const plain = stripAnsi(report);
        await Bun.write(outputPath, plain);
        console.log(pc.green(`Report written to ${outputPath}`));
    }
}

const SEARCH_DEFAULT_PERIODS = "2024,2025,2026";
const SEARCH_DEFAULT_DISTRICT = "Hradec Králové";
const SEARCH_CONSTRUCTION_TYPES = ["panel", "brick"];

function formatCzk(value: number): string {
    return value.toLocaleString("cs-CZ");
}

async function runSearch(query: string, options: ReasOptions): Promise<void> {
    const district = resolveDistrict(options.district ?? SEARCH_DEFAULT_DISTRICT);
    const periods = parsePeriods(options.periods ?? SEARCH_DEFAULT_PERIODS);
    const constructionTypes = options.type ? [options.type] : SEARCH_CONSTRUCTION_TYPES;
    const refresh = !!options.refresh;
    const queryLower = query.toLowerCase();

    const spinner = p.spinner();
    spinner.start(`Searching sold listings for "${query}"...`);

    const allListings: ReasListing[] = [];

    for (const constructionType of constructionTypes) {
        const filters: AnalysisFilters = {
            estateType: "flat",
            constructionType,
            periods,
            district,
        };

        for (const period of periods) {
            const listings = await fetchSoldListings(filters, period, refresh);
            allListings.push(...listings);
        }
    }

    const matched = allListings.filter((l) => l.formattedAddress.toLowerCase().includes(queryLower));

    spinner.stop(`Fetched ${allListings.length} listings, filtering by "${query}".`);

    if (matched.length === 0) {
        console.log(pc.yellow(`\nNo listings found matching "${query}".`));
        return;
    }

    matched.sort((a, b) => new Date(b.soldAt).getTime() - new Date(a.soldAt).getTime());

    const rows = matched.map((listing, idx) => {
        const pricePerM2 = listing.utilityArea > 0 ? Math.round(listing.soldPrice / listing.utilityArea) : 0;
        const soldDate = listing.soldAt ? listing.soldAt.slice(0, 10) : "—";
        const link = listing.link || "—";

        return [
            String(idx + 1),
            listing.formattedAddress,
            listing.disposition,
            String(Math.round(listing.utilityArea)),
            formatCzk(listing.soldPrice),
            formatCzk(pricePerM2),
            soldDate,
            link,
        ];
    });

    const headers = ["#", "Address", "Disp", "m²", "Sold Price", "CZK/m²", "Sold", "Link"];
    const table = formatTable(rows, headers, {
        alignRight: [0, 3, 4, 5],
    });

    console.log(
        `\n${pc.cyan(pc.bold(`Search results for "${query}"`))} — ${pc.bold(String(matched.length))} listing${matched.length === 1 ? "" : "s"} found\n`
    );
    console.log(table);
    console.log();
}

async function runReasAnalysis(options: ReasOptions): Promise<void> {
    if (options.refresh) {
        await clearCache();
        console.log(pc.dim("Cache cleared."));
    }

    if (options.search) {
        await runSearch(options.search, options);
        return;
    }

    if (hasSufficientFlags(options)) {
        const { filters, target } = buildFromFlags(options);
        await fetchAndAnalyze(filters, target, !!options.refresh, options.output);
        return;
    }

    const { filters, target, refresh } = await runInteractiveWizard();
    await fetchAndAnalyze(filters, target, refresh, options.output);
}

export function registerReasCommand(program: Command): void {
    program
        .command("reas")
        .description("Real estate investment analyzer (reas.cz + sreality + MF cenová mapa)")
        .option("--district <name>", "District name (e.g. 'Hradec Králové')")
        .option("--type <type>", "Property type: panel, brick, house")
        .option("--disposition <disp>", "Disposition (e.g. 3+1, 3+kk, 2+1)")
        .option("--periods <periods>", "Comma-separated periods (e.g. 2024,2025)")
        .option("--price <czk>", "Target property asking price in CZK")
        .option("--area <m2>", "Target property area in m²")
        .option("--rent <czk>", "Expected monthly rent in CZK")
        .option("--monthly-costs <czk>", "Monthly costs (fond oprav + utilities) in CZK")
        .option("--search <query>", "Search sold listings by address (e.g. 'Gebauerova')")
        .option("-o, --output <path>", "Write report to file")
        .option("--refresh", "Force re-fetch (ignore cache)")
        .action(async (opts: ReasOptions) => {
            await runReasAnalysis(opts);
        });
}
