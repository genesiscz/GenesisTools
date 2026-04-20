/**
 * REAS Historical Backfill
 *
 * Interactive CLI to backfill sold listings from the REAS catalog API
 * into the local SQLite database.
 *
 * Usage:
 *   bun run src/Internal/commands/reas/backfill.ts
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { DISTRICTS, type DistrictInfo } from "./data/districts";

// ─── Config ────────────────────────────────────────────────────────────────────

const CLIENT_ID = "6988cb437c5b9d2963280369";
const BASE_URL = "https://catalog.reas.cz/catalog";
const PAGE_LIMIT = 200;
const MAX_PAGES = 1000;
const DB_PATH = join(process.env.HOME || "/root", ".genesis-tools", "internal", "reas", "reas.sqlite");

const ALL_YEARS = [2020, 2021, 2022, 2023, 2024, 2025];

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ReasListing {
    _id: string;
    formattedAddress: string;
    formattedLocation?: string;
    soldPrice: number;
    price?: number;
    originalPrice?: number;
    histogramPrice?: number;
    disposition?: string;
    floorArea?: number;
    utilityArea?: number;
    displayArea?: number;
    soldAt: string;
    firstVisibleAt?: string;
    link?: string;
    type: string;
    subType?: string;
    cadastralAreaSlug?: string;
    municipalitySlug?: string;
    streetSlug?: string;
    point?: { type: string; coordinates: [number, number] };
}

interface PriceStats {
    sum: number;
    count: number;
    min: number;
    max: number;
    median: number;
}

// ─── API ───────────────────────────────────────────────────────────────────────

function buildParams(constructionType: string, year: number, districtId: number, page: number): URLSearchParams {
    const params = new URLSearchParams();
    params.set("estateTypes", SafeJSON.stringify(["flat"]));
    params.set("constructionType", SafeJSON.stringify([constructionType]));
    params.set(
        "soldDateRange",
        SafeJSON.stringify({
            from: `${year}-01-01T00:00:00.000Z`,
            to: `${year}-12-31T23:59:59.999Z`,
        })
    );
    params.set("linkedToTransfer", "true");
    params.set("locality", SafeJSON.stringify({ districtId }));
    params.set("clientId", CLIENT_ID);
    params.set("page", String(page));
    params.set("limit", String(PAGE_LIMIT));
    return params;
}

async function fetchSoldCount(districtId: number, constructionType: string, year: number): Promise<number> {
    const params = buildParams(constructionType, year, districtId, 1);
    const url = `${BASE_URL}/listings/count?${params.toString()}`;
    const res = await fetch(url);

    if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching count for year=${year}`);
    }

    const body = (await res.json()) as { success: boolean; data: { count: number } };

    if (!body.success) {
        throw new Error(`REAS API error fetching count for year=${year}`);
    }

    return body.data.count;
}

async function fetchAllSoldListings(
    districtId: number,
    constructionType: string,
    year: number,
    onProgress?: (page: number, fetched: number) => void
): Promise<ReasListing[]> {
    const allListings: ReasListing[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
        const params = buildParams(constructionType, year, districtId, page);
        const url = `${BASE_URL}/listings?${params.toString()}`;
        const res = await fetch(url);

        if (!res.ok) {
            throw new Error(`HTTP ${res.status} for page ${page}`);
        }

        const body = (await res.json()) as {
            success: boolean;
            data: ReasListing[];
            nextPage: number | null;
        };

        if (!body.success) {
            throw new Error(`REAS API error for page ${page}`);
        }

        allListings.push(...body.data);
        onProgress?.(page, allListings.length);

        if (body.nextPage !== null && page < MAX_PAGES) {
            page = body.nextPage;
        } else {
            hasMore = false;
        }

        await new Promise((resolve) => setTimeout(resolve, 200));
    }

    return allListings;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function computePricePerM2(listing: ReasListing): number | null {
    const price = listing.soldPrice;
    const area = listing.floorArea ?? listing.displayArea ?? listing.utilityArea;

    if (!price || !area || area <= 0) {
        return null;
    }

    return Math.round(price / area);
}

function computeStats(listings: ReasListing[]): PriceStats | null {
    const prices = listings.map((l) => computePricePerM2(l)).filter((p): p is number => p !== null);

    if (prices.length === 0) {
        return null;
    }

    prices.sort((a, b) => a - b);
    const sum = prices.reduce((a, b) => a + b, 0);

    return {
        sum,
        count: prices.length,
        min: prices[0],
        max: prices[prices.length - 1],
        median: prices[Math.floor(prices.length / 2)],
    };
}

// ─── DB ────────────────────────────────────────────────────────────────────────

function insertListings(
    db: Database,
    listings: ReasListing[],
    districtName: string,
    constructionType: string
): { inserted: number; skipped: number; errors: number } {
    const insert = db.prepare(`
        INSERT OR IGNORE INTO listings (
            source, source_contract, type, status, district, disposition,
            area, price, price_per_m2, address, link, source_id,
            fetched_at, sold_at, building_type, raw_json, created_at, updated_at,
            coordinates_lat, coordinates_lng
        ) VALUES (
            'reas', 'reas-catalog', 'flat', 'sold', ?, ?,
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, datetime('now'), datetime('now'),
            ?, ?
        )
    `);

    let inserted = 0;
    let skipped = 0;
    let errors = 0;

    for (const listing of listings) {
        try {
            const pricePerM2 = computePricePerM2(listing);
            const area = listing.floorArea ?? listing.displayArea ?? listing.utilityArea ?? null;
            const lat = listing.point?.coordinates?.[1] ?? null;
            const lng = listing.point?.coordinates?.[0] ?? null;
            const soldAt = listing.soldAt ? new Date(listing.soldAt).toISOString() : null;

            const result = insert.run(
                districtName,
                listing.disposition ?? null,
                area,
                listing.soldPrice,
                pricePerM2,
                listing.formattedAddress,
                listing.link ?? "",
                listing._id,
                new Date().toISOString(),
                soldAt,
                constructionType,
                SafeJSON.stringify(listing),
                lat,
                lng
            );

            if (result.changes > 0) {
                inserted++;
            } else {
                skipped++;
            }
        } catch (err) {
            errors++;
            if (errors <= 3) {
                p.log.error(`Error inserting ${listing._id}: ${(err as Error).message}`);
            }
        }
    }

    return { inserted, skipped, errors };
}

// ─── Prompts ───────────────────────────────────────────────────────────────────

async function promptDistrict(): Promise<DistrictInfo | symbol> {
    // Group by region for nicer display
    const districtNames = Object.keys(DISTRICTS).sort((a, b) => a.localeCompare(b, "cs"));

    const selection = await p.select({
        message: "Select a district to backfill",
        options: [
            {
                value: "__search__",
                label: "Search for a district...",
            },
            ...districtNames.map((name) => ({
                value: name,
                label: name,
                hint: String(DISTRICTS[name].reasId),
            })),
        ],
    });

    if (p.isCancel(selection)) {
        p.cancel("Cancelled.");
        return selection;
    }

    if (selection === "__search__") {
        const query = await p.text({
            message: "Search districts:",
            placeholder: "e.g. Brno, Ostrava, Plzeň...",
        });

        if (p.isCancel(query)) {
            p.cancel("Cancelled.");
            return query;
        }
        if (!query.trim()) {
            p.cancel("Cancelled.");
            process.exit(0);
        }

        const lower = query.toLowerCase();
        const matches = Object.entries(DISTRICTS)
            .filter(([name]) => name.toLowerCase().includes(lower))
            .sort(([, a], [, b]) => a.name.localeCompare(b.name, "cs"));

        if (matches.length === 0) {
            p.log.error(`No districts found matching "${query}".`);
            return promptDistrict();
        }

        if (matches.length === 1) {
            p.log.info(`Found: ${matches[0][1].name} (ID: ${matches[0][1].reasId})`);
            return matches[0][1];
        }

        const match = await p.select({
            message: `Found ${matches.length} districts:`,
            options: matches.map(([name, info]) => ({
                value: name,
                label: name,
                hint: String(info.reasId),
            })),
        });

        if (p.isCancel(match)) {
            p.cancel("Cancelled.");
            return match;
        }

        return DISTRICTS[match];
    }

    return DISTRICTS[selection];
}

async function promptYears(): Promise<number[] | symbol> {
    const choices = await p.multiselect({
        message: "Select years to backfill",
        options: ALL_YEARS.map((year) => ({
            value: String(year),
            label: String(year),
        })),
        required: true,
    });

    if (p.isCancel(choices)) {
        p.cancel("Cancelled.");
        return choices;
    }

    return choices.map(Number);
}

async function promptConstructionTypes(): Promise<readonly string[] | symbol> {
    const choices = await p.multiselect({
        message: "Select construction types",
        options: [
            { value: "brick", label: "Brick (cihlová)", hint: "Most common" },
            { value: "panel", label: "Panel (panelová)" },
        ],
        required: true,
        initialValues: ["brick", "panel"],
    });

    if (p.isCancel(choices)) {
        p.cancel("Cancelled.");
        return choices;
    }

    return choices as unknown as readonly string[];
}

// ─── Main ──────────────────────────────────────────────────────────────────────

export async function main() {
    p.intro(pc.bgCyan(pc.black(" REAS Historical Backfill ")));

    const db = new Database(DB_PATH);

    // 1. Select district
    const district = await promptDistrict();
    if (typeof district === "symbol") {
        return process.exit(0);
    }

    p.log.info(`Selected: ${pc.cyan(district.name)} (REAS ID: ${district.reasId})`);

    // 2. Select years
    const years = await promptYears();
    if (typeof years === "symbol") {
        return process.exit(0);
    }

    // 3. Select construction types
    const constructionTypes = await promptConstructionTypes();
    if (typeof constructionTypes === "symbol") {
        return process.exit(0);
    }

    // 4. Show counts preview
    const spinner = p.spinner();
    spinner.start("Checking available data in REAS...");

    const countTable: {
        year: number;
        type: string;
        count: number;
    }[] = [];

    for (const year of years) {
        for (const ct of constructionTypes) {
            const count = await fetchSoldCount(district.reasId, ct, year);
            countTable.push({ year, type: ct, count });
        }
    }

    spinner.stop("Data check complete.");

    const totalAvailable = countTable.reduce((sum, row) => sum + row.count, 0);

    // Show preview table
    p.note(
        [
            "Year       Brick    Panel     Total",
            "─────────────────────────────────────",
            ...years.map((year) => {
                const brickRow = countTable.find((r) => r.year === year && r.type === "brick");
                const panelRow = countTable.find((r) => r.year === year && r.type === "panel");
                const brick = brickRow?.count ?? 0;
                const panel = panelRow?.count ?? 0;
                return `${year}       ${String(brick).padStart(4)}    ${String(panel).padStart(4)}     ${brick + panel}`;
            }),
            "─────────────────────────────────────",
            `Total     ${countTable
                .filter((r) => r.type === "brick")
                .reduce((s, r) => s + r.count, 0)
                .toString()
                .padStart(4)}    ${countTable
                .filter((r) => r.type === "panel")
                .reduce((s, r) => s + r.count, 0)
                .toString()
                .padStart(4)}     ${pc.bold(String(totalAvailable))}`,
        ].join("\n"),
        `Available listings for ${district.name}`
    );

    if (totalAvailable === 0) {
        p.log.warn("No listings found for the selected combination.");
        return process.exit(0);
    }

    // 5. Confirm
    const proceed = await p.confirm({
        message: `Fetch and insert ${pc.bold(String(totalAvailable))} listings into the database?`,
        initialValue: true,
    });

    if (p.isCancel(proceed) || !proceed) {
        p.cancel("Aborted.");
        return process.exit(0);
    }

    // 6. Execute
    const totals = { fetched: 0, inserted: 0, skipped: 0, errors: 0 };
    const priceStatsMap = new Map<string, PriceStats>();

    for (const year of years) {
        for (const ct of constructionTypes) {
            const countRow = countTable.find((r) => r.year === year && r.type === ct);

            if (!countRow || countRow.count === 0) {
                continue;
            }

            const key = `${year}-${ct}`;
            const fetchSpinner = p.spinner();
            fetchSpinner.start(`${pc.cyan(String(year))} ${pc.dim(ct)} — fetching ${countRow.count} listings...`);

            try {
                const listings = await fetchAllSoldListings(district.reasId, ct, year, (page, fetched) => {
                    fetchSpinner.message(
                        `${pc.cyan(String(year))} ${pc.dim(ct)} — page ${page}, ${fetched}/${countRow.count} listings...`
                    );
                });

                totals.fetched += listings.length;

                const stats = computeStats(listings);
                if (stats) {
                    priceStatsMap.set(key, stats);
                }

                const result = insertListings(db, listings, district.name, ct);
                totals.inserted += result.inserted;
                totals.skipped += result.skipped;
                totals.errors += result.errors;

                const parts = [`${listings.length} fetched`];

                if (result.inserted > 0) {
                    parts.push(`${pc.green(`${result.inserted} inserted`)}`);
                }

                if (result.skipped > 0) {
                    parts.push(`${pc.yellow(`${result.skipped} skipped`)}`);
                }

                if (result.errors > 0) {
                    parts.push(`${pc.red(`${result.errors} errors`)}`);
                }

                if (stats) {
                    parts.push(`median ${pc.bold(`${stats.median.toLocaleString()}`)} CZK/m2`);
                }

                fetchSpinner.stop(parts.join(", "));
            } catch (err) {
                fetchSpinner.stop(`${pc.red("Error:")} ${(err as Error).message}`);
            }
        }
    }

    // 7. Results
    console.log();
    p.log.success(`Done! ${pc.bold(String(totals.inserted))} new listings inserted.`);

    if (totals.skipped > 0) {
        p.log.info(`${pc.yellow(String(totals.skipped))} listings already existed (skipped).`);
    }

    if (totals.errors > 0) {
        p.log.warn(`${pc.red(String(totals.errors))} errors during insertion.`);
    }

    // Price trend summary
    if (priceStatsMap.size > 0) {
        console.log();
        const header = ["Year", "Type", "Count", "Median", "Avg", "Min", "Max"].join("  ");
        const divider = "─".repeat(65);

        p.note(
            [divider, header, divider]
                .concat(
                    years.flatMap((year) =>
                        constructionTypes.flatMap((ct) => {
                            const stats = priceStatsMap.get(`${year}-${ct}`);
                            if (!stats) {
                                return [];
                            }
                            return [
                                [
                                    String(year).padEnd(6),
                                    ct.padEnd(8),
                                    String(stats.count).padEnd(8),
                                    stats.median.toLocaleString().padStart(10),
                                    Math.round(stats.sum / stats.count)
                                        .toLocaleString()
                                        .padStart(10),
                                    stats.min.toLocaleString().padStart(10),
                                    stats.max.toLocaleString().padStart(10),
                                ].join("  "),
                            ];
                        })
                    )
                )
                .join("\n"),
            "Price per m2 (CZK) — Sold Listings"
        );
    }

    p.outro(pc.green("Backfill complete."));
}

main().catch((err) => {
    p.log.error(`Fatal: ${(err as Error).message}`);
    process.exit(1);
});
