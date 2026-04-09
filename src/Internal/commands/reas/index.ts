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

        const resolved = getDistrict(subDistrict) ?? getDistrict("Praha");

        if (!resolved) {
            p.cancel("Could not resolve district.");
            process.exit(1);
        }

        district = resolved;
    } else {
        const resolved = getDistrict(districtName as string);

        if (!resolved) {
            p.cancel(`Unknown district: ${districtName}`);
            process.exit(1);
        }

        district = resolved;
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

function parseRequiredNumber(raw: string | undefined, label: string): number {
    const num = Number(raw);

    if (!Number.isFinite(num) || num < 0) {
        throw new Error(`Invalid ${label}: "${raw}". Please provide a positive number.`);
    }

    return num;
}

export async function buildFromFlags(
    options: ReasOptions
): Promise<{ filters: AnalysisFilters; target: TargetProperty }> {
    const district = options.address
        ? await resolveDistrictFromAddress(options.address)
        : resolveDistrict(options.district!);

    const price = parseRequiredNumber(options.price, "--price");
    const area = parseRequiredNumber(options.area, "--area");
    const rent = options.rent ? parseRequiredNumber(options.rent, "--rent") : 0;
    const monthlyCosts = options.monthlyCosts ? parseRequiredNumber(options.monthlyCosts, "--monthly-costs") : 0;

    return buildConfig({
        district,
        constructionType: options.type!,
        disposition: options.disposition,
        periodsStr: options.periods,
        price,
        area,
        rent,
        monthlyCosts,
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
    const reas = program
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
        .option("--format <format>", "Output format: terminal (default), json, pdf", "terminal")
        .option("-o, --output <path>", "Write report to file")
        .option("--refresh", "Force re-fetch (ignore cache)")
        .option("--server", "Start dashboard API server")
        .option("--port <port>", "Server port (default: 3456)", parseInt)
        .option("--dashboard", "Launch React dashboard")
        .option("--dashboard-port <port>", "Dashboard port", "3072")
        .action(async (opts: ReasOptions) => {
            await runReasAnalysis(opts);
        });

    // ---- Subcommand: listings ----
    reas.command("listings")
        .description("Browse stored listings from the database")
        .option("--district <name>", "Filter by district name")
        .option("--type <type>", "Listing type: sale, rental, sold")
        .option("--source <name>", "Filter by data source")
        .option("--limit <n>", "Number of rows to show", "20")
        .option("--page <n>", "Page number (1-based)", "1")
        .action(async (opts: { district?: string; type?: string; source?: string; limit: string; page: string }) => {
            const { reasDatabase } = await import("@app/Internal/commands/reas/lib/store");

            const limit = Number(opts.limit);
            const page = Number(opts.page);
            const offset = (page - 1) * limit;

            const listings = reasDatabase.getListings({
                district: opts.district,
                type: opts.type as "sale" | "rental" | "sold" | undefined,
                source: opts.source,
                limit,
                offset,
            });

            if (listings.length === 0) {
                console.log(pc.yellow("No listings found."));
                return;
            }

            const rows = listings.map((l) => [
                String(l.id),
                l.district,
                l.source,
                l.type,
                l.address.length > 40 ? `${l.address.slice(0, 37)}...` : l.address,
                l.disposition ?? "—",
                l.area != null ? String(Math.round(l.area)) : "—",
                formatCzk(l.price),
                l.price_per_m2 != null ? formatCzk(Math.round(l.price_per_m2)) : "—",
                l.fetched_at.slice(0, 10),
            ]);

            const headers = ["ID", "District", "Source", "Type", "Address", "Disp", "m²", "Price", "CZK/m²", "Date"];
            const table = formatTable(rows, headers, { alignRight: [0, 6, 7, 8] });

            console.log(
                `\n${pc.cyan(pc.bold("Listings"))} — page ${pc.bold(String(page))}, ${pc.bold(String(listings.length))} rows\n`
            );
            console.log(table);
            console.log();
        });

    // ---- Subcommand: districts ----
    // Uses optional positional [query] instead of --search to avoid conflict with parent's --search flag
    reas.command("districts [query]")
        .description("List all districts, or search by name (e.g. reas districts Prah)")
        .action((query?: string) => {
            if (query) {
                const matches = searchDistricts(query);

                if (matches.length === 0) {
                    console.log(pc.yellow(`No districts matching "${query}".`));
                    return;
                }

                console.log(`\n${pc.cyan(pc.bold("District search"))} — "${query}" → ${matches.length} match(es)\n`);

                for (const d of matches) {
                    console.log(`  ${pc.bold(d.name)}  ${pc.dim(`reasId=${d.reasId}  srealityId=${d.srealityId}`)}`);
                }

                console.log();
                return;
            }

            const prahaNames = getPrahaDistrictNames();
            const allNames = getAllDistrictNames();

            console.log(
                `\n${pc.cyan(pc.bold("Available districts"))} (${allNames.length} districts + ${prahaNames.length} Praha wards)\n`
            );
            console.log(pc.bold("Praha districts:"));

            for (const name of prahaNames) {
                console.log(`  ${name}`);
            }

            console.log();
            console.log(pc.bold("All districts (alphabetical):"));

            for (const name of allNames) {
                console.log(`  ${name}`);
            }

            console.log();
        });

    // ---- Subcommand: history ----
    reas.command("history")
        .description("Show past analysis runs from the database")
        .option("--district <name>", "Filter by district name")
        .option("--type <construction>", "Filter by construction type (panel, brick, house)")
        .option("--limit <n>", "Number of rows", "20")
        .action(async (opts: { district?: string; type?: string; limit: string }) => {
            const { reasDatabase } = await import("@app/Internal/commands/reas/lib/store");

            const limit = Number(opts.limit);
            let rows = reasDatabase.getHistory({ district: opts.district, limit });

            if (opts.type) {
                rows = rows.filter((r) => r.construction_type === opts.type);
            }

            if (rows.length === 0) {
                console.log(pc.yellow("No analysis history found."));
                return;
            }

            const tableRows = rows.map((r) => [
                r.created_at.slice(0, 10),
                r.district,
                r.construction_type,
                r.disposition ?? "all",
                r.investment_score != null ? String(r.investment_score) : "—",
                r.investment_grade ?? "—",
                r.net_yield != null ? `${r.net_yield.toFixed(1)}%` : "—",
                r.median_price_per_m2 != null ? formatCzk(Math.round(r.median_price_per_m2)) : "—",
            ]);

            const headers = ["Date", "District", "Type", "Disp", "Score", "Grade", "Net Yield", "Median CZK/m²"];
            const table = formatTable(tableRows, headers, { alignRight: [4, 6, 7] });

            console.log(`\n${pc.cyan(pc.bold("Analysis history"))} — ${pc.bold(String(rows.length))} entries\n`);
            console.log(table);
            console.log();
        });

    // ---- Subcommand: health ----
    reas.command("health")
        .description("Show provider health stats and recent fetch log")
        .option("--days <n>", "Lookback window in days", "30")
        .action(async (opts: { days: string }) => {
            const { reasDatabase } = await import("@app/Internal/commands/reas/lib/store");

            const days = Number(opts.days);
            const health = reasDatabase.getProviderHealth(days);
            const recentLog = reasDatabase.getRecentFetchLog(20);

            if (health.length === 0) {
                console.log(pc.yellow("No provider health data found."));
                return;
            }

            // Provider health table
            const healthRows = health.map((h) => [
                h.provider,
                `${h.successRate.toFixed(1)}%`,
                String(h.avgListingCount),
                String(h.totalFetches),
                h.lastError ? (h.lastError.length > 40 ? `${h.lastError.slice(0, 37)}...` : h.lastError) : "—",
            ]);

            const healthHeaders = ["Provider", "Success%", "Avg Count", "Fetches", "Last Error"];
            const healthTable = formatTable(healthRows, healthHeaders, { alignRight: [1, 2, 3] });

            console.log(`\n${pc.cyan(pc.bold("Provider health"))} — last ${pc.bold(String(days))} days\n`);
            console.log(healthTable);

            // Recent fetch log table
            if (recentLog.length > 0) {
                const logRows = recentLog.map((l) => {
                    const statusColor = l.status === "success" ? pc.green : l.status === "error" ? pc.red : pc.yellow;
                    return [
                        l.created_at.slice(0, 16).replace("T", " "),
                        l.provider,
                        l.source_contract,
                        l.district ?? "—",
                        statusColor(l.status),
                        String(l.listing_count),
                    ];
                });

                const logHeaders = ["Timestamp", "Provider", "Contract", "District", "Status", "Count"];
                const logTable = formatTable(logRows, logHeaders, { alignRight: [5] });

                console.log(`\n${pc.cyan(pc.bold("Recent fetches"))} — last ${pc.bold(String(recentLog.length))}\n`);
                console.log(logTable);
            }

            console.log();
        });

    // ---- Subcommand: compare ----
    reas.command("compare <districts...>")
        .description("Compare multiple districts side by side")
        .option("--type <construction>", "Construction type (panel, brick, house)", "brick")
        .option("--disposition <disp>", "Disposition filter (e.g. 3+1)")
        .option("--price <czk>", "Target price in CZK", "5000000")
        .option("--area <m2>", "Target area in m²", "80")
        .action(
            async (districts: string[], opts: { type: string; disposition?: string; price: string; area: string }) => {
                const { compareDistricts } = await import(
                    "@app/Internal/commands/reas/lib/district-comparison-service"
                );

                const spinner = p.spinner();
                spinner.start(`Comparing ${districts.length} districts...`);

                const results = await compareDistricts({
                    districts,
                    constructionType: opts.type,
                    disposition: opts.disposition,
                    price: Number(opts.price),
                    area: Number(opts.area),
                });

                spinner.stop(`Compared ${results.length} district(s).`);

                if (results.length === 0) {
                    console.log(pc.yellow("No comparison results."));
                    return;
                }

                const rows = results.map((r) => [
                    r.district,
                    formatCzk(Math.round(r.summary.medianPricePerM2)),
                    `${r.summary.grossYield.toFixed(1)}%`,
                    `${r.summary.netYield.toFixed(1)}%`,
                    String(r.summary.salesCount),
                    String(r.summary.rentalCount),
                ]);

                const headers = ["District", "Median CZK/m²", "Gross Yield", "Net Yield", "Sales", "Rentals"];
                const table = formatTable(rows, headers, { alignRight: [1, 2, 3, 4, 5] });

                console.log(
                    `\n${pc.cyan(pc.bold("District comparison"))} — ${opts.type}, ${formatCzk(Number(opts.price))} CZK, ${opts.area} m²\n`
                );
                console.log(table);
                console.log();
            }
        );

    // ---- Subcommand: listing ----
    reas.command("listing <id>")
        .description("Show detail for a stored listing by ID")
        .action(async (idStr: string) => {
            const { getListingDetail } = await import("@app/Internal/commands/reas/lib/listing-service");

            const id = Number(idStr);

            if (Number.isNaN(id)) {
                console.log(pc.red(`Invalid ID: "${idStr}"`));
                return;
            }

            const result = await getListingDetail(id);

            if (result === null) {
                console.log(pc.yellow(`Listing ${id} not found.`));
                return;
            }

            const l = result.listing;
            const rows = [
                ["ID", String(l.id)],
                ["Source", l.source],
                ["Contract", l.source_contract],
                ["Type", l.type],
                ["Status", l.status],
                ["District", l.district],
                ["Address", l.address],
                ["Disposition", l.disposition ?? "—"],
                ["Area (m²)", l.area != null ? String(l.area) : "—"],
                ["Price (CZK)", formatCzk(l.price)],
                ["CZK/m²", l.price_per_m2 != null ? formatCzk(Math.round(l.price_per_m2)) : "—"],
                ["Link", l.link],
                ["Fetched", l.fetched_at],
            ];

            console.log(`\n${pc.cyan(pc.bold(`Listing #${l.id}`))}\n`);
            console.log(formatTable(rows, [], {}));

            if (result.linkedProperty !== null) {
                console.log(pc.dim(`Linked property: #${result.linkedProperty.id} ${result.linkedProperty.name}`));
            }

            if (result.hydratedDetail !== null) {
                const raw = SafeJSON.stringify(result.hydratedDetail);
                const truncated = raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
                console.log(`\nLive detail: ${truncated}`);
            }

            console.log();
        });

    // ---- Subcommand: property ----
    reas.command("property <id>")
        .description("Show detail for a saved watchlist property by ID")
        .action(async (idStr: string) => {
            const { getPropertyDetail } = await import("@app/Internal/commands/reas/lib/property-service");

            const id = Number(idStr);

            if (Number.isNaN(id)) {
                console.log(pc.red(`Invalid ID: "${idStr}"`));
                return;
            }

            const result = getPropertyDetail(id);

            if (result === null) {
                console.log(pc.yellow(`Property ${id} not found.`));
                return;
            }

            const prop = result.property;
            const rows = [
                ["ID", String(prop.id)],
                ["Name", prop.name],
                ["District", prop.district],
                ["Type", prop.construction_type],
                ["Disposition", prop.disposition ?? "—"],
                ["Price (CZK)", formatCzk(prop.target_price)],
                ["Area (m²)", String(prop.target_area)],
                ["Rent", formatCzk(prop.monthly_rent)],
                ["Costs", formatCzk(prop.monthly_costs)],
                ["Score", prop.last_score != null ? String(prop.last_score) : "—"],
                ["Grade", prop.last_grade ?? "—"],
                ["Net Yield", prop.last_net_yield != null ? `${prop.last_net_yield.toFixed(1)}%` : "—"],
                ["Gross Yield", prop.last_gross_yield != null ? `${prop.last_gross_yield.toFixed(1)}%` : "—"],
                [
                    "Median CZK/m²",
                    prop.last_median_price_per_m2 != null ? formatCzk(Math.round(prop.last_median_price_per_m2)) : "—",
                ],
                ["Last analyzed", prop.last_analyzed_at ?? "—"],
            ];

            console.log(`\n${pc.cyan(pc.bold(`Property #${prop.id} — ${prop.name}`))}\n`);
            console.log(formatTable(rows, [], {}));

            if (result.history.length > 0) {
                console.log(pc.bold("\nAnalysis history:\n"));

                const historyRows = result.history.map((h) => [
                    h.analyzed_at.slice(0, 10),
                    h.grade ?? "—",
                    h.score != null ? String(h.score) : "—",
                    h.net_yield != null ? `${h.net_yield.toFixed(1)}%` : "—",
                    h.gross_yield != null ? `${h.gross_yield.toFixed(1)}%` : "—",
                    h.median_price_per_m2 != null ? formatCzk(Math.round(h.median_price_per_m2)) : "—",
                    h.comparable_count != null ? String(h.comparable_count) : "—",
                ]);

                const historyHeaders = [
                    "Date",
                    "Grade",
                    "Score",
                    "Net Yield",
                    "Gross Yield",
                    "Median CZK/m²",
                    "Comparables",
                ];
                console.log(formatTable(historyRows, historyHeaders, { alignRight: [2, 3, 4, 5, 6] }));
            }

            console.log();
        });

    // ---- Subcommand: snapshots ----
    reas.command("snapshots")
        .description("Show historical district price snapshots")
        .requiredOption("--district <name>", "District name (required)")
        .option("--type <construction>", "Construction type (panel, brick, house)", "brick")
        .option("--disposition <disp>", "Disposition filter")
        .option("--days <n>", "Lookback window in days", "365")
        .option("--resolution <r>", "daily or monthly", "monthly")
        .action(
            async (opts: {
                district: string;
                type: string;
                disposition?: string;
                days: string;
                resolution: string;
            }) => {
                const { reasDatabase } = await import("@app/Internal/commands/reas/lib/store");
                const { collapseDistrictSnapshots } = await import("@app/Internal/commands/reas/lib/district-snapshot");

                const resolution = opts.resolution;

                if (resolution !== "daily" && resolution !== "monthly") {
                    console.log(pc.red(`Invalid resolution "${resolution}". Use "daily" or "monthly".`));
                    return;
                }

                const rows = reasDatabase.getDistrictHistory(
                    opts.district,
                    opts.type,
                    Number(opts.days),
                    opts.disposition
                );
                const snapshots = collapseDistrictSnapshots({
                    rows,
                    resolution,
                });

                if (snapshots.length === 0) {
                    console.log(pc.yellow(`No snapshots found for ${opts.district}.`));
                    return;
                }

                const tableRows = snapshots.map((s) => [
                    s.snapshotDate,
                    formatCzk(Math.round(s.medianPricePerM2)),
                    s.trendDirection ?? "—",
                    s.yoyChange != null ? `${s.yoyChange.toFixed(1)}%` : "—",
                    s.marketGrossYield != null ? `${s.marketGrossYield.toFixed(1)}%` : "—",
                    s.marketNetYield != null ? `${s.marketNetYield.toFixed(1)}%` : "—",
                    String(s.comparablesCount),
                ]);

                const headers = ["Date", "Median CZK/m²", "Trend", "YoY%", "Gross Yield%", "Net Yield%", "Count"];

                console.log(
                    `\n${pc.cyan(pc.bold(`District snapshots — ${opts.district} (${opts.type})`))} — ${snapshots.length} entries (${opts.resolution})\n`
                );
                console.log(formatTable(tableRows, headers, { alignRight: [1, 3, 4, 5, 6] }));
                console.log();
            }
        );
}
