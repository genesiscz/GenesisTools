import { homedir } from "node:os";
import { join } from "node:path";
import { getListingPersistenceDistrict } from "@app/Internal/commands/reas/lib/district-matching";
import type { FullAnalysis } from "@app/Internal/commands/reas/types";
import { BaseDatabase } from "@app/utils/database";
import { SafeJSON } from "@app/utils/json";

const DEFAULT_DB_PATH = join(homedir(), ".genesis-tools", "internal", "reas", "reas.sqlite");

export interface AnalysisHistoryRow {
    id: number;
    district: string;
    construction_type: string;
    disposition: string | null;
    target_price: number;
    target_area: number;
    monthly_rent: number;
    monthly_costs: number;
    median_price_per_m2: number | null;
    investment_score: number | null;
    investment_grade: string | null;
    net_yield: number | null;
    gross_yield: number | null;
    median_days_on_market: number | null;
    median_discount: number | null;
    comparables_count: number | null;
    full_result: string;
    filters_json: string;
    target_json: string;
    created_at: string;
    data_fetched_at: string | null;
}

export interface SavedPropertyRow {
    id: number;
    name: string;
    district: string;
    construction_type: string;
    disposition: string | null;
    target_price: number;
    target_area: number;
    monthly_rent: number;
    monthly_costs: number;
    periods: string | null;
    providers: string | null;
    listing_url: string | null;
    last_score: number | null;
    last_grade: string | null;
    last_net_yield: number | null;
    last_gross_yield: number | null;
    last_median_price_per_m2: number | null;
    score: number | null;
    gross_yield: number | null;
    payback_years: number | null;
    percentile: number | null;
    comparable_count: number | null;
    rental_count: number | null;
    time_on_market: number | null;
    discount_vs_market: number | null;
    momentum: string | null;
    last_analysis_json: string | null;
    mortgage_rate: number | null;
    mortgage_term: number | null;
    down_payment: number | null;
    loan_amount: number | null;
    alert_yield_floor: number | null;
    alert_grade_change: number | null;
    last_analyzed_at: string | null;
    notes: string | null;
    created_at: string;
    updated_at: string;
}

export interface PropertyAnalysisHistoryRow {
    id: number;
    property_id: number;
    analyzed_at: string;
    grade: string | null;
    score: number | null;
    net_yield: number | null;
    gross_yield: number | null;
    median_price_per_m2: number | null;
    comparable_count: number | null;
    rental_median: number | null;
    full_result_json: string;
}

export interface ListingRow {
    id: number;
    source: string;
    source_contract: string;
    type: string;
    status: string;
    district: string;
    disposition: string | null;
    area: number | null;
    price: number;
    price_per_m2: number | null;
    address: string;
    link: string;
    source_id: string;
    fetched_at: string;
    sold_at: string | null;
    days_on_market: number | null;
    discount: number | null;
    coordinates_lat: number | null;
    coordinates_lng: number | null;
    building_type: string | null;
    description: string | null;
    raw_json: string;
    previous_price: number | null;
    price_changed_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface UpsertListingInput {
    source: string;
    sourceContract: string;
    type: "sale" | "rental" | "sold";
    status: "active" | "sold" | "removed";
    sourceId: string;
    district: string;
    disposition?: string;
    area?: number;
    price: number;
    pricePerM2?: number;
    address: string;
    link: string;
    fetchedAt: string;
    soldAt?: string;
    daysOnMarket?: number;
    discount?: number;
    coordinatesLat?: number;
    coordinatesLng?: number;
    buildingType?: string;
    description?: string;
    rawJson: string;
}

export interface ReplaceListingsSnapshotOptions {
    district: string;
    type: "sale" | "rental" | "sold";
    source: string;
    sourceContract?: string;
}

export interface RepairListingDistrictsOptions {
    district?: string;
    types?: Array<"sale" | "rental" | "sold">;
    sources?: string[];
}

export interface GetListingsOptions {
    type?: "sale" | "rental" | "sold";
    district?: string;
    disposition?: string;
    dispositions?: string[];
    source?: string;
    sources?: string[];
    priceMin?: number;
    priceMax?: number;
    areaMin?: number;
    areaMax?: number;
    seenFrom?: string;
    seenTo?: string;
    sortBy?: "fetched_at" | "sold_at" | "price" | "price_per_m2" | "area";
    sortDir?: "asc" | "desc";
    limit?: number;
    offset?: number;
}

export interface SavePropertyInput {
    name: string;
    district: string;
    constructionType: string;
    disposition?: string;
    targetPrice: number;
    targetArea: number;
    monthlyRent: number;
    monthlyCosts: number;
    periods?: string;
    providers?: string;
    listingUrl?: string;
    mortgageRate?: number;
    mortgageTerm?: number;
    downPayment?: number;
    loanAmount?: number;
    alertYieldFloor?: number;
    alertGradeChange?: boolean;
    notes?: string;
}

export interface UpdatePropertySettingsInput {
    alertYieldFloor?: number;
    alertGradeChange?: boolean;
}

export interface RentEstimate {
    medianRent: number;
    medianRentPerM2: number;
    listingCount: number;
}

export interface ListingsOverview {
    saleCount: number;
    rentalCount: number;
    soldCount: number;
    saleLastFetchedAt: string | null;
    rentalLastFetchedAt: string | null;
    soldLastFetchedAt: string | null;
    lastFetchedAt: string | null;
    sourceCount: number;
    sources: Array<{
        source: string;
        count: number;
        lastFetchedAt: string | null;
    }>;
    districtSources: DistrictSourceRow[];
}

export interface DistrictSourceRow {
    district: string;
    source: string;
    type: string;
    count: number;
    lastFetchedAt: string | null;
}

export interface DistrictSnapshotRow {
    id: number;
    district: string;
    construction_type: string;
    disposition: string | null;
    median_price_per_m2: number;
    comparables_count: number;
    trend_direction: string | null;
    yoy_change: number | null;
    market_gross_yield: number | null;
    market_net_yield: number | null;
    snapshot_date: string;
    created_at: string;
}

export interface ProviderFetchLogRow {
    id: number;
    provider: string;
    source_contract: string;
    district: string | null;
    status: "success" | "error" | "empty";
    listing_count: number;
    duration_ms: number | null;
    error_message: string | null;
    created_at: string;
}

export interface ProviderHealthSummary {
    provider: string;
    totalFetches: number;
    successCount: number;
    errorCount: number;
    emptyCount: number;
    successRate: number;
    avgDurationMs: number | null;
    avgListingCount: number;
    lastFetchedAt: string | null;
    lastError: string | null;
}

export class ReasDatabase extends BaseDatabase {
    constructor(dbPath: string = DEFAULT_DB_PATH) {
        super(dbPath);
    }

    protected initSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS analysis_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                district TEXT NOT NULL,
                construction_type TEXT NOT NULL,
                disposition TEXT,
                target_price INTEGER NOT NULL,
                target_area REAL NOT NULL,
                monthly_rent INTEGER NOT NULL,
                monthly_costs INTEGER NOT NULL,
                median_price_per_m2 REAL,
                investment_score INTEGER,
                investment_grade TEXT,
                net_yield REAL,
                gross_yield REAL,
                median_days_on_market REAL,
                median_discount REAL,
                comparables_count INTEGER,
                full_result TEXT NOT NULL,
                filters_json TEXT NOT NULL,
                target_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                data_fetched_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_ah_district ON analysis_history(district);
            CREATE INDEX IF NOT EXISTS idx_ah_created ON analysis_history(created_at);

            CREATE TABLE IF NOT EXISTS saved_properties (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                district TEXT NOT NULL,
                construction_type TEXT NOT NULL,
                disposition TEXT,
                target_price INTEGER NOT NULL,
                target_area REAL NOT NULL,
                monthly_rent INTEGER NOT NULL,
                monthly_costs INTEGER NOT NULL,
                periods TEXT,
                providers TEXT,
                listing_url TEXT,
                last_score INTEGER,
                last_grade TEXT,
                last_net_yield REAL,
                last_gross_yield REAL,
                last_median_price_per_m2 REAL,
                score INTEGER,
                gross_yield REAL,
                payback_years REAL,
                percentile REAL,
                comparable_count INTEGER,
                rental_count INTEGER,
                time_on_market REAL,
                discount_vs_market REAL,
                momentum TEXT,
                last_analysis_json TEXT,
                mortgage_rate REAL,
                mortgage_term INTEGER,
                down_payment REAL,
                loan_amount REAL,
                alert_yield_floor REAL,
                alert_grade_change INTEGER DEFAULT 0,
                last_analyzed_at TEXT,
                notes TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS property_analysis_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                property_id INTEGER NOT NULL,
                analyzed_at TEXT NOT NULL DEFAULT (datetime('now')),
                grade TEXT,
                score INTEGER,
                net_yield REAL,
                gross_yield REAL,
                median_price_per_m2 REAL,
                comparable_count INTEGER,
                rental_median REAL,
                full_result_json TEXT NOT NULL,
                FOREIGN KEY (property_id) REFERENCES saved_properties(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_pah_property ON property_analysis_history(property_id, analyzed_at DESC);

            CREATE TABLE IF NOT EXISTS listings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                source_contract TEXT NOT NULL,
                type TEXT NOT NULL,
                status TEXT NOT NULL,
                district TEXT NOT NULL,
                disposition TEXT,
                area REAL,
                price INTEGER NOT NULL,
                price_per_m2 REAL,
                address TEXT NOT NULL,
                link TEXT NOT NULL,
                source_id TEXT NOT NULL,
                fetched_at TEXT NOT NULL,
                sold_at TEXT,
                days_on_market REAL,
                discount REAL,
                coordinates_lat REAL,
                coordinates_lng REAL,
                building_type TEXT,
                description TEXT,
                raw_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(source, source_contract, source_id, type)
            );
            CREATE INDEX IF NOT EXISTS idx_listings_type_district ON listings(type, district);
            CREATE INDEX IF NOT EXISTS idx_listings_source ON listings(source, source_id);

            CREATE TABLE IF NOT EXISTS district_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                district TEXT NOT NULL,
                construction_type TEXT NOT NULL,
                disposition TEXT,
                median_price_per_m2 REAL NOT NULL,
                comparables_count INTEGER NOT NULL,
                trend_direction TEXT,
                yoy_change REAL,
                market_gross_yield REAL,
                market_net_yield REAL,
                snapshot_date TEXT NOT NULL DEFAULT (date('now')),
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_ds_district ON district_snapshots(district, snapshot_date);

            CREATE TABLE IF NOT EXISTS provider_fetch_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                provider TEXT NOT NULL,
                source_contract TEXT NOT NULL,
                district TEXT,
                status TEXT NOT NULL,
                listing_count INTEGER NOT NULL DEFAULT 0,
                duration_ms INTEGER,
                error_message TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_pfl_provider ON provider_fetch_log(provider, created_at DESC);
        `);

        this.ensureColumn("saved_properties", "listing_url", "TEXT");
        this.ensureColumn("saved_properties", "last_gross_yield", "REAL");
        this.ensureColumn("saved_properties", "score", "INTEGER");
        this.ensureColumn("saved_properties", "gross_yield", "REAL");
        this.ensureColumn("saved_properties", "payback_years", "REAL");
        this.ensureColumn("saved_properties", "percentile", "REAL");
        this.ensureColumn("saved_properties", "comparable_count", "INTEGER");
        this.ensureColumn("saved_properties", "rental_count", "INTEGER");
        this.ensureColumn("saved_properties", "time_on_market", "REAL");
        this.ensureColumn("saved_properties", "discount_vs_market", "REAL");
        this.ensureColumn("saved_properties", "momentum", "TEXT");
        this.ensureColumn("saved_properties", "last_analysis_json", "TEXT");
        this.ensureColumn("saved_properties", "mortgage_rate", "REAL");
        this.ensureColumn("saved_properties", "mortgage_term", "INTEGER");
        this.ensureColumn("saved_properties", "down_payment", "REAL");
        this.ensureColumn("saved_properties", "loan_amount", "REAL");
        this.ensureColumn("saved_properties", "alert_yield_floor", "REAL");
        this.ensureColumn("saved_properties", "alert_grade_change", "INTEGER DEFAULT 0");
        this.ensureColumn("district_snapshots", "market_gross_yield", "REAL");
        this.ensureColumn("district_snapshots", "market_net_yield", "REAL");
        this.ensureColumn("listings", "previous_price", "INTEGER");
        this.ensureColumn("listings", "price_changed_at", "TEXT");
    }

    saveAnalysis(analysis: FullAnalysis): number {
        const stmt = this.db.prepare(`
            INSERT INTO analysis_history (
                district, construction_type, disposition,
                target_price, target_area, monthly_rent, monthly_costs,
                median_price_per_m2, investment_score, investment_grade,
                net_yield, gross_yield,
                median_days_on_market, median_discount, comparables_count,
                full_result, filters_json, target_json
            ) VALUES (
                $district, $construction_type, $disposition,
                $target_price, $target_area, $monthly_rent, $monthly_costs,
                $median_price_per_m2, $investment_score, $investment_grade,
                $net_yield, $gross_yield,
                $median_days_on_market, $median_discount, $comparables_count,
                $full_result, $filters_json, $target_json
            )
        `);

        const result = stmt.run({
            $district: analysis.target.district,
            $construction_type: analysis.target.constructionType,
            $disposition: analysis.filters.disposition ?? null,
            $target_price: analysis.target.price,
            $target_area: analysis.target.area,
            $monthly_rent: analysis.target.monthlyRent,
            $monthly_costs: analysis.target.monthlyCosts,
            $median_price_per_m2: analysis.comparables.pricePerM2.median ?? null,
            $investment_score: analysis.investmentScore?.overall ?? null,
            $investment_grade: analysis.investmentScore?.grade ?? null,
            $net_yield: analysis.yield.netYield ?? null,
            $gross_yield: analysis.yield.grossYield ?? null,
            $median_days_on_market: analysis.timeOnMarket.median ?? null,
            $median_discount: analysis.discount.medianDiscount ?? null,
            $comparables_count: analysis.comparables.listings.length,
            $full_result: SafeJSON.stringify(analysis),
            $filters_json: SafeJSON.stringify(analysis.filters),
            $target_json: SafeJSON.stringify(analysis.target),
        });

        return Number(result.lastInsertRowid);
    }

    getHistory(options?: { district?: string; limit?: number }): AnalysisHistoryRow[] {
        const limit = options?.limit ?? 50;

        if (options?.district) {
            return this.db
                .prepare(
                    "SELECT * FROM analysis_history WHERE district = $district ORDER BY created_at DESC LIMIT $limit"
                )
                .all({ $district: options.district, $limit: limit }) as AnalysisHistoryRow[];
        }

        return this.db
            .prepare("SELECT * FROM analysis_history ORDER BY created_at DESC LIMIT $limit")
            .all({ $limit: limit }) as AnalysisHistoryRow[];
    }

    saveProperty(input: SavePropertyInput): number {
        const stmt = this.db.prepare(`
            INSERT INTO saved_properties (
                name, district, construction_type, disposition,
                target_price, target_area, monthly_rent, monthly_costs,
                periods, providers, listing_url,
                mortgage_rate, mortgage_term, down_payment, loan_amount,
                alert_yield_floor, alert_grade_change,
                notes
            ) VALUES (
                $name, $district, $construction_type, $disposition,
                $target_price, $target_area, $monthly_rent, $monthly_costs,
                $periods, $providers, $listing_url,
                $mortgage_rate, $mortgage_term, $down_payment, $loan_amount,
                $alert_yield_floor, $alert_grade_change,
                $notes
            )
        `);

        const result = stmt.run({
            $name: input.name,
            $district: input.district,
            $construction_type: input.constructionType,
            $disposition: input.disposition ?? null,
            $target_price: input.targetPrice,
            $target_area: input.targetArea,
            $monthly_rent: input.monthlyRent,
            $monthly_costs: input.monthlyCosts,
            $periods: input.periods ?? null,
            $providers: input.providers ?? null,
            $listing_url: input.listingUrl ?? null,
            $mortgage_rate: input.mortgageRate ?? null,
            $mortgage_term: input.mortgageTerm ?? null,
            $down_payment: input.downPayment ?? null,
            $loan_amount: input.loanAmount ?? null,
            $alert_yield_floor: input.alertYieldFloor ?? null,
            $alert_grade_change: input.alertGradeChange ? 1 : 0,
            $notes: input.notes ?? null,
        });

        return Number(result.lastInsertRowid);
    }

    getProperties(): SavedPropertyRow[] {
        return this.db.prepare("SELECT * FROM saved_properties ORDER BY updated_at DESC").all() as SavedPropertyRow[];
    }

    getProperty(id: number): SavedPropertyRow | null {
        return (
            (this.db.prepare("SELECT * FROM saved_properties WHERE id = $id").get({ $id: id }) as
                | SavedPropertyRow
                | undefined) ?? null
        );
    }

    getPropertyByListingUrl(listingUrl: string): SavedPropertyRow | null {
        return (
            (this.db
                .prepare(
                    "SELECT * FROM saved_properties WHERE listing_url = $listing_url ORDER BY updated_at DESC LIMIT 1"
                )
                .get({ $listing_url: listingUrl }) as SavedPropertyRow | undefined) ?? null
        );
    }

    updatePropertySettings(id: number, input: UpdatePropertySettingsInput): void {
        this.db
            .prepare(`
                UPDATE saved_properties SET
                    alert_yield_floor = $alert_yield_floor,
                    alert_grade_change = $alert_grade_change,
                    updated_at = datetime('now')
                WHERE id = $id
            `)
            .run({
                $id: id,
                $alert_yield_floor: input.alertYieldFloor ?? null,
                $alert_grade_change: input.alertGradeChange ? 1 : 0,
            });
    }

    updatePropertyAnalysis(id: number, analysis: FullAnalysis): void {
        const serializedAnalysis = SafeJSON.stringify(analysis);
        const rentalMedian = this.getRentalMedian(analysis);

        this.db
            .prepare(`
                UPDATE saved_properties SET
                    last_score = $last_score,
                    last_grade = $last_grade,
                    last_net_yield = $last_net_yield,
                    last_gross_yield = $last_gross_yield,
                    last_median_price_per_m2 = $last_median_price_per_m2,
                    score = $score,
                    gross_yield = $gross_yield,
                    payback_years = $payback_years,
                    percentile = $percentile,
                    comparable_count = $comparable_count,
                    rental_count = $rental_count,
                    time_on_market = $time_on_market,
                    discount_vs_market = $discount_vs_market,
                    momentum = $momentum,
                    last_analysis_json = $last_analysis_json,
                    last_analyzed_at = datetime('now'),
                    updated_at = datetime('now')
                WHERE id = $id
            `)
            .run({
                $id: id,
                $last_score: analysis.investmentScore?.overall ?? null,
                $last_grade: analysis.investmentScore?.grade ?? null,
                $last_net_yield: analysis.yield.netYield ?? null,
                $last_gross_yield: analysis.yield.grossYield ?? null,
                $last_median_price_per_m2: analysis.comparables.pricePerM2.median ?? null,
                $score: analysis.investmentScore?.overall ?? null,
                $gross_yield: analysis.yield.grossYield ?? null,
                $payback_years: Number.isFinite(analysis.yield.paybackYears) ? analysis.yield.paybackYears : null,
                $percentile: analysis.comparables.targetPercentile ?? null,
                $comparable_count: analysis.comparables.listings.length,
                $rental_count: analysis.rentalListings.length,
                $time_on_market: analysis.timeOnMarket.median ?? null,
                $discount_vs_market: analysis.discount.medianDiscount ?? null,
                $momentum: analysis.momentum?.direction ?? null,
                $last_analysis_json: serializedAnalysis,
            });

        this.db
            .prepare(`
                INSERT INTO property_analysis_history (
                    property_id,
                    grade,
                    score,
                    net_yield,
                    gross_yield,
                    median_price_per_m2,
                    comparable_count,
                    rental_median,
                    full_result_json
                ) VALUES (
                    $property_id,
                    $grade,
                    $score,
                    $net_yield,
                    $gross_yield,
                    $median_price_per_m2,
                    $comparable_count,
                    $rental_median,
                    $full_result_json
                )
            `)
            .run({
                $property_id: id,
                $grade: analysis.investmentScore?.grade ?? null,
                $score: analysis.investmentScore?.overall ?? null,
                $net_yield: analysis.yield.netYield ?? null,
                $gross_yield: analysis.yield.grossYield ?? null,
                $median_price_per_m2: analysis.comparables.pricePerM2.median ?? null,
                $comparable_count: analysis.comparables.listings.length,
                $rental_median: rentalMedian,
                $full_result_json: serializedAnalysis,
            });

        this.db
            .prepare(`
                DELETE FROM property_analysis_history
                WHERE property_id = $property_id
                  AND id NOT IN (
                      SELECT id FROM property_analysis_history
                      WHERE property_id = $property_id
                      ORDER BY analyzed_at DESC, id DESC
                      LIMIT 100
                  )
            `)
            .run({ $property_id: id });
    }

    getPropertyAnalysisHistory(propertyId: number, limit = 50): PropertyAnalysisHistoryRow[] {
        return this.db
            .prepare(`
                SELECT * FROM property_analysis_history
                WHERE property_id = $property_id
                ORDER BY analyzed_at DESC, id DESC
                LIMIT $limit
            `)
            .all({ $property_id: propertyId, $limit: limit }) as PropertyAnalysisHistoryRow[];
    }

    deleteProperty(id: number): void {
        this.db.prepare("DELETE FROM saved_properties WHERE id = $id").run({ $id: id });
    }

    upsertListings(listings: UpsertListingInput[], district?: string): void {
        const stmt = this.db.prepare(`
            INSERT INTO listings (
                source,
                source_contract,
                type,
                status,
                district,
                disposition,
                area,
                price,
                price_per_m2,
                address,
                link,
                source_id,
                fetched_at,
                sold_at,
                days_on_market,
                discount,
                coordinates_lat,
                coordinates_lng,
                building_type,
                description,
                raw_json,
                updated_at
            ) VALUES (
                $source,
                $source_contract,
                $type,
                $status,
                $district,
                $disposition,
                $area,
                $price,
                $price_per_m2,
                $address,
                $link,
                $source_id,
                $fetched_at,
                $sold_at,
                $days_on_market,
                $discount,
                $coordinates_lat,
                $coordinates_lng,
                $building_type,
                $description,
                $raw_json,
                datetime('now')
            )
            ON CONFLICT(source, source_contract, source_id, type)
            DO UPDATE SET
                status = excluded.status,
                district = excluded.district,
                disposition = excluded.disposition,
                area = excluded.area,
                previous_price = CASE WHEN listings.price != excluded.price THEN listings.price ELSE listings.previous_price END,
                price_changed_at = CASE WHEN listings.price != excluded.price THEN datetime('now') ELSE listings.price_changed_at END,
                price = excluded.price,
                price_per_m2 = excluded.price_per_m2,
                address = excluded.address,
                link = excluded.link,
                fetched_at = excluded.fetched_at,
                sold_at = excluded.sold_at,
                days_on_market = excluded.days_on_market,
                discount = excluded.discount,
                coordinates_lat = excluded.coordinates_lat,
                coordinates_lng = excluded.coordinates_lng,
                building_type = excluded.building_type,
                description = excluded.description,
                raw_json = excluded.raw_json,
                updated_at = datetime('now')
        `);

        for (const listing of listings) {
            stmt.run({
                $source: listing.source,
                $source_contract: listing.sourceContract,
                $type: listing.type,
                $status: listing.status,
                $district: listing.district || district || "",
                $disposition: listing.disposition ?? null,
                $area: listing.area ?? null,
                $price: listing.price,
                $price_per_m2: listing.pricePerM2 ?? null,
                $address: listing.address,
                $link: listing.link,
                $source_id: listing.sourceId,
                $fetched_at: listing.fetchedAt,
                $sold_at: listing.soldAt ?? null,
                $days_on_market: listing.daysOnMarket ?? null,
                $discount: listing.discount ?? null,
                $coordinates_lat: listing.coordinatesLat ?? null,
                $coordinates_lng: listing.coordinatesLng ?? null,
                $building_type: listing.buildingType ?? null,
                $description: listing.description ?? null,
                $raw_json: listing.rawJson,
            });
        }
    }

    replaceListingsSnapshot(options: ReplaceListingsSnapshotOptions): void {
        const where = ["district = $district", "type = $type", "source = $source"];
        const params: Record<string, string> = {
            $district: options.district,
            $type: options.type,
            $source: options.source,
        };

        if (options.sourceContract) {
            where.push("source_contract = $source_contract");
            params.$source_contract = options.sourceContract;
        }

        this.db.prepare(`DELETE FROM listings WHERE ${where.join(" AND ")}`).run(params);
    }

    repairListingDistricts(options: RepairListingDistrictsOptions = {}): { scanned: number; repaired: number } {
        const where: string[] = [];
        const params: Record<string, string> = {};

        if (options.district) {
            where.push("district = $district");
            params.$district = options.district;
        }

        if (options.types && options.types.length > 0) {
            const typePlaceholders = options.types.map((_, index) => `$type_${index}`);
            where.push(`type IN (${typePlaceholders.join(", ")})`);

            for (const [index, type] of options.types.entries()) {
                params[`$type_${index}`] = type;
            }
        }

        if (options.sources && options.sources.length > 0) {
            const sourcePlaceholders = options.sources.map((_, index) => `$source_${index}`);
            where.push(`source IN (${sourcePlaceholders.join(", ")})`);

            for (const [index, source] of options.sources.entries()) {
                params[`$source_${index}`] = source;
            }
        }

        const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
        const rows = this.db
            .prepare(`SELECT id, district, address, raw_json FROM listings ${whereClause} ORDER BY id ASC`)
            .all(params) as Array<{ id: number; district: string; address: string; raw_json: string | null }>;
        const stmt = this.db.prepare(
            "UPDATE listings SET district = $district, updated_at = datetime('now') WHERE id = $id"
        );
        let repaired = 0;

        for (const row of rows) {
            const rawJson = row.raw_json ? (SafeJSON.parse(row.raw_json) as Record<string, unknown>) : null;
            const localityCandidates = [
                row.address,
                typeof rawJson?.locality === "string" ? rawJson.locality : null,
                typeof rawJson?.formattedAddress === "string" ? rawJson.formattedAddress : null,
                typeof rawJson?.formattedLocation === "string" ? rawJson.formattedLocation : null,
                typeof rawJson?.municipalitySlug === "string" ? rawJson.municipalitySlug : null,
                typeof rawJson?.cadastralAreaSlug === "string" ? rawJson.cadastralAreaSlug : null,
            ]
                .filter((value): value is string => Boolean(value?.trim()))
                .join(" ");
            const nextDistrict = getListingPersistenceDistrict({
                requestedDistrict: row.district,
                locality: localityCandidates,
            });

            if (!nextDistrict || nextDistrict === row.district) {
                continue;
            }

            stmt.run({ $district: nextDistrict, $id: row.id });
            repaired++;
        }

        return { scanned: rows.length, repaired };
    }

    getListings(options: GetListingsOptions = {}): ListingRow[] {
        const { whereClause, params } = this.buildListingsQuery(options);
        const orderColumn = options.sortBy ?? "fetched_at";
        const orderDirection = options.sortDir === "asc" ? "ASC" : "DESC";

        return this.db
            .prepare(`
                SELECT * FROM listings
                ${whereClause}
                ORDER BY ${orderColumn} ${orderDirection}, id DESC
                LIMIT $limit OFFSET $offset
            `)
            .all(params) as ListingRow[];
    }

    getListingsCount(options: GetListingsOptions = {}): number {
        const { whereClause, params } = this.buildListingsQuery(options);
        const result = this.db
            .prepare(`
                SELECT COUNT(*) as count FROM listings
                ${whereClause}
            `)
            .get(params) as { count: number } | undefined;

        return result?.count ?? 0;
    }

    private buildListingsQuery(options: GetListingsOptions): {
        whereClause: string;
        params: Record<string, string | number>;
    } {
        const where: string[] = [];
        const params: Record<string, string | number> = {
            $limit: options.limit ?? 100,
            $offset: options.offset ?? 0,
        };

        if (options.type) {
            where.push("type = $type");
            params.$type = options.type;
        }

        if (options.district) {
            where.push("district = $district");
            params.$district = options.district;
        }

        if (options.disposition) {
            where.push("disposition = $disposition");
            params.$disposition = options.disposition;
        }

        if (options.dispositions && options.dispositions.length > 0) {
            const placeholders = options.dispositions.map((_, index) => `$disposition_${index}`);
            where.push(`disposition IN (${placeholders.join(", ")})`);

            for (const [index, disposition] of options.dispositions.entries()) {
                params[`$disposition_${index}`] = disposition;
            }
        }

        if (options.source) {
            where.push("source = $source");
            params.$source = options.source;
        }

        if (options.sources && options.sources.length > 0) {
            const placeholders = options.sources.map((_, index) => `$source_${index}`);
            where.push(`source IN (${placeholders.join(", ")})`);

            for (const [index, source] of options.sources.entries()) {
                params[`$source_${index}`] = source;
            }
        }

        if (options.priceMin !== undefined) {
            where.push("price >= $price_min");
            params.$price_min = options.priceMin;
        }

        if (options.priceMax !== undefined) {
            where.push("price <= $price_max");
            params.$price_max = options.priceMax;
        }

        if (options.areaMin !== undefined) {
            where.push("area >= $area_min");
            params.$area_min = options.areaMin;
        }

        if (options.areaMax !== undefined) {
            where.push("area <= $area_max");
            params.$area_max = options.areaMax;
        }

        if (options.seenFrom) {
            where.push("date(COALESCE(sold_at, fetched_at)) >= date($seen_from)");
            params.$seen_from = options.seenFrom;
        }

        if (options.seenTo) {
            where.push("date(COALESCE(sold_at, fetched_at)) <= date($seen_to)");
            params.$seen_to = options.seenTo;
        }

        const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

        return { whereClause, params };
    }

    getListing(id: number): ListingRow | null {
        return (
            (this.db.prepare("SELECT * FROM listings WHERE id = $id").get({ $id: id }) as ListingRow | undefined) ??
            null
        );
    }

    getListingByUrl(url: string): ListingRow | null {
        return (
            (this.db
                .prepare("SELECT * FROM listings WHERE link = $link ORDER BY updated_at DESC, id DESC LIMIT 1")
                .get({
                    $link: url,
                }) as ListingRow | undefined) ?? null
        );
    }

    estimateMonthlyRent(options: { district: string; disposition?: string; area?: number }): RentEstimate | null {
        const where = ["type = 'rental'", "status = 'active'", "district = $district"];
        const params: Record<string, string | number> = {
            $district: options.district,
        };

        if (options.disposition) {
            where.push("disposition = $disposition");
            params.$disposition = options.disposition;
        }

        if (options.area && options.area > 0) {
            where.push("area BETWEEN $area_min AND $area_max");
            params.$area_min = Math.max(0, options.area - 12);
            params.$area_max = options.area + 12;
        }

        const rows = this.db
            .prepare(
                `SELECT price, price_per_m2 FROM listings WHERE ${where.join(" AND ")} ORDER BY price ASC, id ASC LIMIT 50`
            )
            .all(params) as Array<{ price: number; price_per_m2: number | null }>;

        if (rows.length === 0) {
            return null;
        }

        const rents = rows.map((row) => row.price);
        const rentsPerM2 = rows.map((row) => row.price_per_m2).filter((value): value is number => value !== null);

        return {
            medianRent: computeMedian(rents),
            medianRentPerM2: rentsPerM2.length > 0 ? computeMedian(rentsPerM2) : 0,
            listingCount: rows.length,
        };
    }

    getListingsOverview(): ListingsOverview {
        const rows = this.db
            .prepare(`
            SELECT type, COUNT(*) as count, MAX(fetched_at) as last_fetched_at
            FROM listings
            GROUP BY type
        `)
            .all() as Array<{ type: string; count: number; last_fetched_at: string | null }>;

        const sourceRows = this.db
            .prepare(`
                SELECT source, COUNT(*) as count, MAX(fetched_at) as last_fetched_at
                FROM listings
                GROUP BY source
                ORDER BY last_fetched_at DESC, source ASC
            `)
            .all() as Array<{ source: string; count: number; last_fetched_at: string | null }>;

        const sourceRow = this.db.prepare("SELECT COUNT(DISTINCT source) as source_count FROM listings").get() as
            | { source_count: number }
            | undefined;

        const districtSourceRows = this.db
            .prepare(`
                SELECT district, source, type, COUNT(*) as count, MAX(fetched_at) as last_fetched_at
                FROM listings
                GROUP BY district, source, type
                ORDER BY district ASC, source ASC, type ASC
            `)
            .all() as Array<{
            district: string;
            source: string;
            type: string;
            count: number;
            last_fetched_at: string | null;
        }>;

        const overview: ListingsOverview = {
            saleCount: 0,
            rentalCount: 0,
            soldCount: 0,
            saleLastFetchedAt: null,
            rentalLastFetchedAt: null,
            soldLastFetchedAt: null,
            lastFetchedAt: null,
            sourceCount: sourceRow?.source_count ?? 0,
            sources: sourceRows.map((row) => ({
                source: row.source,
                count: row.count,
                lastFetchedAt: row.last_fetched_at,
            })),
            districtSources: districtSourceRows.map((row) => ({
                district: row.district,
                source: row.source,
                type: row.type,
                count: row.count,
                lastFetchedAt: row.last_fetched_at,
            })),
        };

        for (const row of rows) {
            if (row.type === "sale") {
                overview.saleCount = row.count;
                overview.saleLastFetchedAt = row.last_fetched_at;
            }

            if (row.type === "rental") {
                overview.rentalCount = row.count;
                overview.rentalLastFetchedAt = row.last_fetched_at;
            }

            if (row.type === "sold") {
                overview.soldCount = row.count;
                overview.soldLastFetchedAt = row.last_fetched_at;
            }
        }

        overview.lastFetchedAt = overview.sources[0]?.lastFetchedAt ?? null;

        return overview;
    }

    saveDistrictSnapshot(analysis: FullAnalysis): void {
        this.db
            .prepare(`
                INSERT INTO district_snapshots (
                    district, construction_type, disposition,
                    median_price_per_m2, comparables_count,
                    trend_direction, yoy_change,
                    market_gross_yield, market_net_yield
                ) VALUES (
                    $district, $construction_type, $disposition,
                    $median_price_per_m2, $comparables_count,
                    $trend_direction, $yoy_change,
                    $market_gross_yield, $market_net_yield
                )
            `)
            .run({
                $district: analysis.target.district,
                $construction_type: analysis.target.constructionType,
                $disposition: analysis.filters.disposition ?? null,
                $median_price_per_m2: analysis.comparables.pricePerM2.median,
                $comparables_count: analysis.comparables.listings.length,
                $trend_direction: analysis.trends.direction ?? null,
                $yoy_change: analysis.trends.yoyChange ?? null,
                $market_gross_yield: analysis.yield.atMarketPrice.grossYield,
                $market_net_yield: analysis.yield.atMarketPrice.netYield,
            });
    }

    getDistrictHistory(
        district: string,
        constructionType: string,
        days = 365,
        disposition?: string
    ): DistrictSnapshotRow[] {
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const normalizedDisposition = disposition && disposition !== "all" ? disposition : null;

        if (!normalizedDisposition) {
            return this.db
                .prepare(`
                    SELECT * FROM district_snapshots
                    WHERE district = $district
                      AND construction_type = $construction_type
                      AND disposition IS NULL
                      AND snapshot_date >= $cutoff
                    ORDER BY snapshot_date ASC
                `)
                .all({
                    $district: district,
                    $construction_type: constructionType,
                    $cutoff: cutoff,
                }) as DistrictSnapshotRow[];
        }

        const matchingRows = this.db
            .prepare(`
                SELECT * FROM district_snapshots
                WHERE district = $district
                  AND construction_type = $construction_type
                  AND disposition = $disposition
                  AND snapshot_date >= $cutoff
                ORDER BY snapshot_date ASC
            `)
            .all({
                $district: district,
                $construction_type: constructionType,
                $disposition: normalizedDisposition,
                $cutoff: cutoff,
            }) as DistrictSnapshotRow[];

        if (matchingRows.length > 0) {
            return matchingRows;
        }

        return this.db
            .prepare(`
                SELECT * FROM district_snapshots
                WHERE district = $district
                  AND construction_type = $construction_type
                  AND disposition IS NULL
                  AND snapshot_date >= $cutoff
                ORDER BY snapshot_date ASC
            `)
            .all({
                $district: district,
                $construction_type: constructionType,
                $cutoff: cutoff,
            }) as DistrictSnapshotRow[];
    }

    getListingsWithPriceChanges(options: { district?: string; type?: string; limit?: number } = {}): ListingRow[] {
        const conditions = ["previous_price IS NOT NULL"];
        const params: Record<string, unknown> = {};

        if (options.district) {
            conditions.push("district = $district");
            params.$district = options.district;
        }

        if (options.type) {
            conditions.push("type = $type");
            params.$type = options.type;
        }

        const limit = options.limit ?? 100;

        return this.db
            .prepare(`
                SELECT * FROM listings
                WHERE ${conditions.join(" AND ")}
                ORDER BY price_changed_at DESC
                LIMIT $limit
            `)
            .all({ ...params, $limit: limit }) as ListingRow[];
    }

    logProviderFetch(input: {
        provider: string;
        sourceContract: string;
        district?: string;
        status: "success" | "error" | "empty";
        listingCount: number;
        durationMs?: number;
        errorMessage?: string;
    }): void {
        this.db
            .prepare(`
                INSERT INTO provider_fetch_log (provider, source_contract, district, status, listing_count, duration_ms, error_message)
                VALUES ($provider, $source_contract, $district, $status, $listing_count, $duration_ms, $error_message)
            `)
            .run({
                $provider: input.provider,
                $source_contract: input.sourceContract,
                $district: input.district ?? null,
                $status: input.status,
                $listing_count: input.listingCount,
                $duration_ms: input.durationMs ?? null,
                $error_message: input.errorMessage ?? null,
            });
    }

    getProviderHealth(days = 30): ProviderHealthSummary[] {
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

        const rows = this.db
            .prepare(`
                SELECT
                    provider,
                    COUNT(*) as total_fetches,
                    SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
                    SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
                    SUM(CASE WHEN status = 'empty' THEN 1 ELSE 0 END) as empty_count,
                    AVG(CASE WHEN status = 'success' THEN duration_ms ELSE NULL END) as avg_duration_ms,
                    AVG(CASE WHEN status = 'success' THEN listing_count ELSE NULL END) as avg_listing_count,
                    MAX(created_at) as last_fetched_at
                FROM provider_fetch_log
                WHERE created_at >= $cutoff
                GROUP BY provider
                ORDER BY provider
            `)
            .all({ $cutoff: cutoff }) as Array<{
            provider: string;
            total_fetches: number;
            success_count: number;
            error_count: number;
            empty_count: number;
            avg_duration_ms: number | null;
            avg_listing_count: number | null;
            last_fetched_at: string | null;
        }>;

        return rows.map((row) => {
            const lastErrorRow = this.db
                .prepare(`
                    SELECT error_message FROM provider_fetch_log
                    WHERE provider = $provider AND status = 'error' AND created_at >= $cutoff
                    ORDER BY created_at DESC LIMIT 1
                `)
                .get({ $provider: row.provider, $cutoff: cutoff }) as { error_message: string } | undefined;

            return {
                provider: row.provider,
                totalFetches: row.total_fetches,
                successCount: row.success_count,
                errorCount: row.error_count,
                emptyCount: row.empty_count,
                successRate: row.total_fetches > 0 ? (row.success_count / row.total_fetches) * 100 : 0,
                avgDurationMs: row.avg_duration_ms ? Math.round(row.avg_duration_ms) : null,
                avgListingCount: Math.round(row.avg_listing_count ?? 0),
                lastFetchedAt: row.last_fetched_at,
                lastError: lastErrorRow?.error_message ?? null,
            };
        });
    }

    getRecentFetchLog(limit = 50): ProviderFetchLogRow[] {
        return this.db
            .prepare(`
                SELECT * FROM provider_fetch_log
                ORDER BY id DESC
                LIMIT $limit
            `)
            .all({ $limit: limit }) as ProviderFetchLogRow[];
    }

    private ensureColumn(table: string, column: string, definition: string): void {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;

        if (columns.some((entry) => entry.name === column)) {
            return;
        }

        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }

    private getRentalMedian(analysis: FullAnalysis): number | null {
        const prices = analysis.rentalListings
            .map((listing) => listing.price)
            .filter((price) => Number.isFinite(price));

        if (prices.length === 0) {
            return null;
        }

        const sorted = [...prices].sort((left, right) => left - right);
        const middle = Math.floor(sorted.length / 2);

        if (sorted.length % 2 === 0) {
            return (sorted[middle - 1] + sorted[middle]) / 2;
        }

        return sorted[middle];
    }
}

function computeMedian(values: number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    const midpoint = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
        return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
    }

    return sorted[midpoint];
}

export const reasDatabase = new ReasDatabase();
