import { homedir } from "node:os";
import { join } from "node:path";
import type { FullAnalysis } from "@app/Internal/commands/reas/types";
import { BaseDatabase } from "@app/utils/database";
import { SafeJSON } from "@app/utils/json";

const DEFAULT_DB_PATH = join(homedir(), ".genesis-tools", "internal", "reas", "reas.sqlite");

// --- Row types ---

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
    last_score: number | null;
    last_grade: string | null;
    last_net_yield: number | null;
    last_median_price_per_m2: number | null;
    last_analyzed_at: string | null;
    notes: string | null;
    created_at: string;
    updated_at: string;
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
    notes?: string;
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
    snapshot_date: string;
    created_at: string;
}

// --- Database class ---

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
                last_score INTEGER,
                last_grade TEXT,
                last_net_yield REAL,
                last_median_price_per_m2 REAL,
                last_analyzed_at TEXT,
                notes TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS district_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                district TEXT NOT NULL,
                construction_type TEXT NOT NULL,
                disposition TEXT,
                median_price_per_m2 REAL NOT NULL,
                comparables_count INTEGER NOT NULL,
                trend_direction TEXT,
                yoy_change REAL,
                snapshot_date TEXT NOT NULL DEFAULT (date('now')),
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_ds_district ON district_snapshots(district, snapshot_date);
        `);
    }

    // --- Analysis history ---

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

    // --- Saved properties ---

    saveProperty(input: SavePropertyInput): number {
        const stmt = this.db.prepare(`
            INSERT INTO saved_properties (
                name, district, construction_type, disposition,
                target_price, target_area, monthly_rent, monthly_costs,
                periods, providers, notes
            ) VALUES (
                $name, $district, $construction_type, $disposition,
                $target_price, $target_area, $monthly_rent, $monthly_costs,
                $periods, $providers, $notes
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

    updatePropertyAnalysis(id: number, analysis: FullAnalysis): void {
        this.db
            .prepare(`
                UPDATE saved_properties SET
                    last_score = $last_score,
                    last_grade = $last_grade,
                    last_net_yield = $last_net_yield,
                    last_median_price_per_m2 = $last_median_price_per_m2,
                    last_analyzed_at = datetime('now'),
                    updated_at = datetime('now')
                WHERE id = $id
            `)
            .run({
                $id: id,
                $last_score: analysis.investmentScore?.overall ?? null,
                $last_grade: analysis.investmentScore?.grade ?? null,
                $last_net_yield: analysis.yield.netYield ?? null,
                $last_median_price_per_m2: analysis.comparables.pricePerM2.median ?? null,
            });
    }

    deleteProperty(id: number): void {
        this.db.prepare("DELETE FROM saved_properties WHERE id = $id").run({ $id: id });
    }

    // --- District snapshots ---

    saveDistrictSnapshot(analysis: FullAnalysis): void {
        this.db
            .prepare(`
                INSERT INTO district_snapshots (
                    district, construction_type, disposition,
                    median_price_per_m2, comparables_count,
                    trend_direction, yoy_change
                ) VALUES (
                    $district, $construction_type, $disposition,
                    $median_price_per_m2, $comparables_count,
                    $trend_direction, $yoy_change
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
            });
    }

    getDistrictHistory(district: string, constructionType: string, days = 365): DistrictSnapshotRow[] {
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

        return this.db
            .prepare(`
                SELECT * FROM district_snapshots
                WHERE district = $district
                  AND construction_type = $construction_type
                  AND snapshot_date >= $cutoff
                ORDER BY snapshot_date ASC
            `)
            .all({
                $district: district,
                $construction_type: constructionType,
                $cutoff: cutoff,
            }) as DistrictSnapshotRow[];
    }
}

export const reasDatabase = new ReasDatabase();
