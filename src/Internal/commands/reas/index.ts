import { isInteractive, suggestCommand } from "@app/utils/cli";
import { SafeJSON } from "@app/utils/json";
import { stripAnsi } from "@app/utils/string";
import { formatTable } from "@app/utils/table";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { analyzeComparables } from "./analysis/comparables";
import { analyzeDiscount } from "./analysis/discount";
import { computeInvestmentScore } from "./analysis/investment-score";
import { detectMomentum } from "./analysis/market-momentum";
import { analyzeRentalYield } from "./analysis/rental-yield";
import { type FullAnalysis, renderReport } from "./analysis/report";
import { analyzeTimeOnMarket } from "./analysis/time-on-market";
import { analyzeTrends } from "./analysis/trends";
import { fetchMfRentalData } from "./api/mf-rental";
import { fetchSoldListings } from "./api/reas-client";
import { fetchRentalListings } from "./api/sreality-client";
import { clearCache } from "./cache/index";
import type { DistrictInfo } from "./data/districts";
import { getAllDistrictNames, getDistrict, getPrahaDistrictNames, searchDistricts } from "./data/districts";
import { resolveAddress } from "./lib/address-resolver";
import type {
    AnalysisFilters,
    DateRange,
    MfRentalBenchmark,
    ProviderName,
    ReasListing,
    SrealityRental,
    TargetProperty,
} from "./types";

interface ReasOptions {
    district?: string;
    address?: string;
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
    priceMin?: string;
    priceMax?: string;
    areaMin?: string;
    areaMax?: string;
    providers?: string;
    format?: string;
    server?: boolean;
    port?: number;
}

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

function buildPeriodOptions(): Array<{ value: string; label: string }> {
    const year = new Date().getFullYear();
    return [
        { value: String(year), label: String(year) },
        { value: String(year - 1), label: String(year - 1) },
        { value: String(year - 2), label: String(year - 2) },
        { value: "last6m", label: "Last 6 months" },
    ];
}

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
    const exact = getDistrict(name);

    if (exact) {
        return exact;
    }

    const matches = searchDistricts(name);

    if (matches.length === 1) {
        return matches[0];
    }

    if (matches.length > 1) {
        throw new Error(`Ambiguous district "${name}". Matches: ${matches.map((d) => d.name).join(", ")}`);
    }

    throw new Error(`Unknown district: "${name}". Use --district with one of: ${getAllDistrictNames().join(", ")}`);
}

async function resolveDistrictFromAddress(address: string): Promise<DistrictInfo> {
    const results = await resolveAddress(address);

    if (results.length === 0) {
        throw new Error(`No district found for address "${address}". Try using --district instead.`);
    }

    if (results.length === 1) {
        return results[0].district;
    }

    const picked = await p.select({
        message: `Multiple districts found for "${address}"`,
        options: results.map((r) => ({
            value: r.district.name,
            label: `${r.district.name} (${r.municipalityName})`,
        })),
    });

    if (p.isCancel(picked)) {
        p.cancel("Operation cancelled.");
        process.exit(0);
    }

    const resolved = getDistrict(picked);

    if (!resolved) {
        throw new Error(`District "${picked}" not found in database`);
    }

    return resolved;
}

function hasSufficientFlags(options: ReasOptions): boolean {
    return !!((options.district || options.address) && options.type && options.price && options.area);
}

async function runInteractiveWizard(): Promise<{ filters: AnalysisFilters; target: TargetProperty; refresh: boolean }> {
    p.intro(pc.cyan(pc.bold("REAS Investment Analyzer")));

    const districtName = await p.select({
        message: "Select district",
        options: [
            ...getAllDistrictNames().map((name) => ({ value: name, label: name })),
            { value: "__search__", label: "Search by name..." },
            { value: "__address__", label: "Search by address (Sreality)..." },
        ],
    });

    if (p.isCancel(districtName)) {
        p.cancel("Operation cancelled.");
        process.exit(0);
    }

    let district: DistrictInfo;

    if (districtName === "__address__") {
        const addressQuery = await p.text({ message: "Enter address or locality" });

        if (p.isCancel(addressQuery)) {
            p.cancel("Operation cancelled.");
            process.exit(0);
        }

        const spinner = p.spinner();
        spinner.start("Searching via Sreality...");
        const addressResults = await resolveAddress(addressQuery);
        spinner.stop(`Found ${addressResults.length} result(s).`);

        if (addressResults.length === 0) {
            p.cancel(`No districts found for "${addressQuery}"`);
            process.exit(1);
        }

        if (addressResults.length === 1) {
            district = addressResults[0].district;
        } else {
            const picked = await p.select({
                message: "Select district",
                options: addressResults.map((r) => ({
                    value: r.district.name,
                    label: `${r.district.name} (${r.municipalityName})`,
                })),
            });

            if (p.isCancel(picked)) {
                p.cancel("Operation cancelled.");
                process.exit(0);
            }

            district = getDistrict(picked) ?? addressResults[0].district;
        }
    } else if (districtName === "__search__") {
        const query = await p.text({ message: "Type city/district name" });

        if (p.isCancel(query)) {
            p.cancel("Operation cancelled.");
            process.exit(0);
        }

        const matches = searchDistricts(query);

        if (matches.length === 0) {
            p.cancel(`No districts found for "${query}"`);
            process.exit(1);
        }

        const picked = await p.select({
            message: "Select from matches",
            options: matches.map((d) => ({ value: d.name, label: d.name })),
        });

        if (p.isCancel(picked)) {
            p.cancel("Operation cancelled.");
            process.exit(0);
        }

        district = getDistrict(picked) ?? matches[0];
    } else if (districtName === "Praha") {
        const subDistrict = await p.select({
            message: "Select Praha district (or city-wide)",
            options: [
                { value: "Praha", label: "Praha (cel\u00E1)" },
                ...getPrahaDistrictNames().map((name) => ({ value: name, label: name })),
            ],
        });

        if (p.isCancel(subDistrict)) {
            p.cancel("Operation cancelled.");
            process.exit(0);
        }

        district = getDistrict(subDistrict) ?? getDistrict("Praha")!;
    } else {
        district = getDistrict(districtName as string)!;
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
        options: buildPeriodOptions(),
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
    const dateRanges = (periods as string[]).map((period) => parsePeriod(period));

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

function parseOptionalNumber(raw: string | undefined): number | undefined {
    if (raw === undefined) {
        return undefined;
    }

    const num = Number(raw);
    return Number.isFinite(num) ? num : undefined;
}

function parseProviders(raw: string | undefined): ProviderName[] | undefined {
    if (!raw) {
        return undefined;
    }

    const valid = new Set<ProviderName>(["reas", "sreality", "ereality", "bezrealitky", "mf"]);
    const tokens = raw.split(",").map((s) => s.trim().toLowerCase());
    const unknown = tokens.filter((t) => !valid.has(t as ProviderName));

    if (unknown.length > 0) {
        throw new Error(`Unknown provider(s): ${unknown.join(", ")}. Valid: ${[...valid].join(", ")}`);
    }

    return tokens.filter((name): name is ProviderName => valid.has(name as ProviderName));
}

export async function buildFromFlags(
    options: ReasOptions
): Promise<{ filters: AnalysisFilters; target: TargetProperty }> {
    const district = options.address
        ? await resolveDistrictFromAddress(options.address)
        : resolveDistrict(options.district!);
    const constructionType = options.type!;
    const disposition = options.disposition && options.disposition !== "all" ? options.disposition : undefined;
    const dateRanges = parsePeriods(options.periods);

    const filters: AnalysisFilters = {
        estateType: "flat",
        constructionType,
        disposition,
        periods: dateRanges,
        district,
        priceMin: parseOptionalNumber(options.priceMin),
        priceMax: parseOptionalNumber(options.priceMax),
        areaMin: parseOptionalNumber(options.areaMin),
        areaMax: parseOptionalNumber(options.areaMax),
        providers: parseProviders(options.providers),
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

function isProviderEnabled(filters: AnalysisFilters, provider: ProviderName): boolean {
    return !filters.providers || filters.providers.includes(provider);
}

function applyListingFilters(listings: ReasListing[], filters: AnalysisFilters): ReasListing[] {
    let result = listings;

    if (filters.priceMin !== undefined) {
        result = result.filter((l) => l.soldPrice >= filters.priceMin!);
    }

    if (filters.priceMax !== undefined) {
        result = result.filter((l) => l.soldPrice <= filters.priceMax!);
    }

    if (filters.areaMin !== undefined) {
        result = result.filter((l) => l.utilityArea >= filters.areaMin!);
    }

    if (filters.areaMax !== undefined) {
        result = result.filter((l) => l.utilityArea <= filters.areaMax!);
    }

    return result;
}

export async function fetchAndAnalyze(
    filters: AnalysisFilters,
    target: TargetProperty,
    refresh: boolean
): Promise<FullAnalysis> {
    const spinner = p.spinner();
    spinner.start("Fetching data from all providers...");

    const warnings: string[] = [];

    // Fetch all providers in parallel
    const [reasResult, srealityResult, mfResult] = await Promise.allSettled([
        isProviderEnabled(filters, "reas")
            ? (async () => {
                  const listings: ReasListing[] = [];
                  for (const period of filters.periods) {
                      listings.push(...(await fetchSoldListings(filters, period, refresh)));
                  }
                  return listings;
              })()
            : Promise.resolve([] as ReasListing[]),
        isProviderEnabled(filters, "sreality")
            ? fetchRentalListings(filters, refresh)
            : Promise.resolve([] as SrealityRental[]),
        isProviderEnabled(filters, "mf")
            ? fetchMfRentalData(filters.district.name, refresh)
            : Promise.resolve([] as MfRentalBenchmark[]),
    ]);

    let allListings: ReasListing[] = [];

    if (reasResult.status === "fulfilled") {
        allListings = reasResult.value;
    } else {
        warnings.push(`REAS: ${reasResult.reason instanceof Error ? reasResult.reason.message : String(reasResult.reason)}`);
    }

    allListings = applyListingFilters(allListings, filters);

    let rentalListings: SrealityRental[] = [];

    if (srealityResult.status === "fulfilled") {
        rentalListings = srealityResult.value;
    } else {
        warnings.push(`Sreality: ${srealityResult.reason instanceof Error ? srealityResult.reason.message : String(srealityResult.reason)}`);
    }

    let mfBenchmarks: MfRentalBenchmark[] = [];

    if (mfResult.status === "fulfilled") {
        mfBenchmarks = mfResult.value;
    } else {
        warnings.push(`MF cenova mapa: ${mfResult.reason instanceof Error ? mfResult.reason.message : String(mfResult.reason)}`);
    }

    spinner.stop(
        `Data fetched: ${allListings.length} sold, ${rentalListings.length} rentals, ${mfBenchmarks.length} MF benchmarks.`
    );

    if (warnings.length > 0) {
        console.log(pc.yellow("\nSome providers returned errors (analysis continues with available data):"));

        for (const w of warnings) {
            console.log(pc.dim(`  - ${w}`));
        }

        console.log();
    }

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

    const momentum = detectMomentum(
        trends.periods.map((period) => ({ medianPerM2: period.medianPerM2, count: period.count }))
    );

    const investmentScore = computeInvestmentScore({
        netYield: yieldResult.netYield,
        discount: discount.medianDiscount,
        trendDirection: trends.direction,
        trendYoY: trends.yoyChange ?? 0,
        medianDaysOnMarket: timeOnMarket.median,
        districtMedianDays: timeOnMarket.median,
    });

    return {
        comparables,
        trends,
        yield: yieldResult,
        timeOnMarket,
        discount,
        rentalListings,
        mfBenchmarks,
        target,
        filters,
        investmentScore,
        momentum,
    };
}

async function outputAnalysis(analysis: FullAnalysis, format: string, outputPath?: string): Promise<void> {
    if (format === "json") {
        const { buildDashboardExport } = await import("./lib/api-export");
        const exportData = buildDashboardExport(analysis);
        const json = SafeJSON.stringify(exportData, null, 2);

        if (outputPath) {
            await Bun.write(outputPath, json);
            console.log(pc.green(`JSON export written to ${outputPath}`));
        } else {
            console.log(json);
        }

        return;
    }

    const report = renderReport(analysis);
    console.log(report);

    if (outputPath) {
        const plain = stripAnsi(report);
        await Bun.write(outputPath, plain);
        console.log(pc.green(`Report written to ${outputPath}`));
    }
}

function getSearchDefaultPeriods(): string {
    const year = new Date().getFullYear();
    return `${year - 2},${year - 1},${year}`;
}
const SEARCH_DEFAULT_DISTRICT = "Hradec Králové";
const SEARCH_CONSTRUCTION_TYPES = ["panel", "brick"];

function formatCzk(value: number): string {
    return value.toLocaleString("cs-CZ");
}

async function runSearch(query: string, options: ReasOptions): Promise<void> {
    const district = resolveDistrict(options.district ?? SEARCH_DEFAULT_DISTRICT);
    const periods = parsePeriods(options.periods ?? getSearchDefaultPeriods());
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
    if (options.server) {
        const { startServer } = await import("./server");
        await startServer(options.port);
        return;
    }

    if (options.refresh) {
        await clearCache();
        console.log(pc.dim("Cache cleared."));
    }

    if (options.search) {
        await runSearch(options.search, options);
        return;
    }

    const format = options.format ?? "terminal";

    if (hasSufficientFlags(options)) {
        const { filters, target } = await buildFromFlags(options);
        const analysis = await fetchAndAnalyze(filters, target, !!options.refresh);
        await outputAnalysis(analysis, format, options.output);
        return;
    }

    if (!isInteractive()) {
        console.error("Missing required flags in non-interactive mode.");
        console.log(
            suggestCommand("tools internal reas", {
                add: ["--district", "Praha", "--type", "brick", "--price", "5000000", "--area", "80"],
            })
        );
        process.exit(1);
    }

    const { filters, target, refresh } = await runInteractiveWizard();
    const analysis = await fetchAndAnalyze(filters, target, refresh);
    await outputAnalysis(analysis, format, options.output);
}

export function registerReasCommand(program: Command): void {
    program
        .command("reas")
        .description("Real estate investment analyzer (reas.cz + sreality + MF cenová mapa)")
        .option("--district <name>", "District name (e.g. 'Hradec Králové')")
        .option("--address <query>", "Resolve district from address via Sreality suggest")
        .option("--type <type>", "Property type: panel, brick, house")
        .option("--disposition <disp>", "Disposition (e.g. 3+1, 3+kk, 2+1)")
        .option("--periods <periods>", "Comma-separated periods (e.g. 2024,2025)")
        .option("--price <czk>", "Target property asking price in CZK")
        .option("--area <m2>", "Target property area in m²")
        .option("--rent <czk>", "Expected monthly rent in CZK")
        .option("--monthly-costs <czk>", "Monthly costs (fond oprav + utilities) in CZK")
        .option("--search <query>", "Search sold listings by address (e.g. 'Gebauerova')")
        .option("--price-min <czk>", "Minimum sold price filter")
        .option("--price-max <czk>", "Maximum sold price filter")
        .option("--area-min <m2>", "Minimum area filter")
        .option("--area-max <m2>", "Maximum area filter")
        .option("--providers <list>", "Comma-separated providers (reas,sreality,mf)")
        .option("--format <format>", "Output format: terminal (default), json", "terminal")
        .option("-o, --output <path>", "Write report to file")
        .option("--refresh", "Force re-fetch (ignore cache)")
        .option("--server", "Start dashboard API server")
        .option("--port <port>", "Server port (default: 3456)", parseInt)
        .action(async (opts: ReasOptions) => {
            await runReasAnalysis(opts);
        });
}
