import { renderReport } from "@app/Internal/commands/reas/analysis/report";
import { clearCache } from "@app/Internal/commands/reas/cache/index";
import type { DistrictInfo } from "@app/Internal/commands/reas/data/districts";
import {
    getAllDistrictNames,
    getDistrict,
    getPrahaDistrictNames,
    searchDistricts,
} from "@app/Internal/commands/reas/data/districts";
import { resolveAddress } from "@app/Internal/commands/reas/lib/address-resolver";
import {
    fetchAndAnalyze as fetchAndAnalyzeService,
    searchListings,
} from "@app/Internal/commands/reas/lib/analysis-service";
import {
    buildConfig,
    buildPeriodOptions,
    DISPOSITIONS,
    hasSufficientFlags,
    PROPERTY_TYPES,
    parsePeriod,
    resolveDistrict,
} from "@app/Internal/commands/reas/lib/config-builder";
import type { AnalysisFilters, FullAnalysis, TargetProperty } from "@app/Internal/commands/reas/types";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import { SafeJSON } from "@app/utils/json";
import { stripAnsi } from "@app/utils/string";
import { formatTable } from "@app/utils/table";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

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
    dashboard?: boolean;
    dashboardPort?: string;
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

export async function buildFromFlags(
    options: ReasOptions
): Promise<{ filters: AnalysisFilters; target: TargetProperty }> {
    const district = options.address
        ? await resolveDistrictFromAddress(options.address)
        : resolveDistrict(options.district!);

    return buildConfig({
        district,
        constructionType: options.type!,
        disposition: options.disposition,
        periodsStr: options.periods,
        price: Number(options.price),
        area: Number(options.area),
        rent: Number(options.rent ?? "0"),
        monthlyCosts: Number(options.monthlyCosts ?? "0"),
        priceMin: options.priceMin,
        priceMax: options.priceMax,
        areaMin: options.areaMin,
        areaMax: options.areaMax,
        providers: options.providers,
    });
}

export async function fetchAndAnalyze(
    filters: AnalysisFilters,
    target: TargetProperty,
    refresh: boolean
): Promise<FullAnalysis> {
    const spinner = p.spinner();
    spinner.start("Fetching data from all providers...");

    const analysis = await fetchAndAnalyzeService(filters, target, refresh, {
        onProgress: (progress) => {
            if (progress.phase === "complete") {
                spinner.stop(progress.message);
            } else {
                spinner.message(progress.message);
            }

            if (progress.warnings && progress.warnings.length > 0) {
                console.log(pc.yellow("\nSome providers returned errors (analysis continues with available data):"));

                for (const w of progress.warnings) {
                    console.log(pc.dim(`  - ${w}`));
                }

                console.log();
            }
        },
    });

    return analysis;
}

async function outputAnalysis(analysis: FullAnalysis, format: string, outputPath?: string): Promise<void> {
    if (format === "json") {
        const { buildDashboardExport } = await import("@app/Internal/commands/reas/lib/api-export");
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

    if (format === "pdf") {
        const { exportToPdf } = await import("@app/Internal/commands/reas/lib/pdf-export");
        const path = outputPath ?? `reas-report-${analysis.target.district}-${Date.now()}.pdf`;
        await exportToPdf(analysis, path);
        console.log(pc.green(`PDF report written to ${path}`));
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

function formatCzk(value: number): string {
    return value.toLocaleString("cs-CZ");
}

async function runSearch(query: string, options: ReasOptions): Promise<void> {
    const spinner = p.spinner();
    spinner.start(`Searching sold listings for "${query}"...`);

    const matched = await searchListings({
        query,
        district: options.district,
        periodsStr: options.periods,
        constructionType: options.type,
        refresh: options.refresh,
    });

    spinner.stop(`Found ${matched.length} listing(s) matching "${query}".`);

    if (matched.length === 0) {
        console.log(pc.yellow(`\nNo listings found matching "${query}".`));
        return;
    }

    const rows = matched.map((listing, idx) => {
        const pricePerM2 = listing.utilityArea > 0 ? Math.round(listing.soldPrice / listing.utilityArea) : 0;
        const soldDate = listing.soldAt ? listing.soldAt.slice(0, 10) : "\u2014";
        const link = listing.link || "\u2014";

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

    const headers = ["#", "Address", "Disp", "m\u00B2", "Sold Price", "CZK/m\u00B2", "Sold", "Link"];
    const table = formatTable(rows, headers, {
        alignRight: [0, 3, 4, 5],
    });

    console.log(
        `\n${pc.cyan(pc.bold(`Search results for "${query}"`))} \u2014 ${pc.bold(String(matched.length))} listing${matched.length === 1 ? "" : "s"} found\n`
    );
    console.log(table);
    console.log();
}

async function runReasAnalysis(options: ReasOptions): Promise<void> {
    if (options.dashboard) {
        const { resolve } = await import("node:path");
        const { spawn } = await import("node:child_process");
        const configPath = resolve(import.meta.dir, "ui/vite.config.ts");
        const port = options.dashboardPort ?? "3072";
        console.log(`Starting REAS dashboard on port ${port}...`);
        const child = spawn("bun", ["--bun", "vite", "dev", "--strictPort", "-c", configPath, "--port", port], {
            stdio: "inherit",
        });

        child.on("error", (err: Error) => console.error("Dashboard failed:", err));
        await new Promise(() => {});
        return;
    }

    if (options.server) {
        const { startServer } = await import("@app/Internal/commands/reas/server");
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
        .option("--dashboard", "Launch React dashboard")
        .option("--dashboard-port <port>", "Dashboard port", "3072")
        .action(async (opts: ReasOptions) => {
            await runReasAnalysis(opts);
        });
}
