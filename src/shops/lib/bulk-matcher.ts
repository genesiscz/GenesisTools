import logger from "@app/logger";
import { similarityScore } from "@app/utils/fuzzy-match";
import { BrandAliasesRepository } from "../db/BrandAliasesRepository";
import type { ShopsDatabase } from "../db/ShopsDatabase";
import { BrandResolver } from "./brand-resolver";
import { MatchExecutor } from "./match-executor";
import { Matcher, type MatcherInput } from "./matcher";
import { MATCHER_CONFIG } from "./matcher-config";
import { compatPackCount } from "./multipack-guard";
import type { Unit } from "./normalize";

export interface BulkMatcherArgs {
    matcher: Matcher;
    shopsDb: ShopsDatabase;
    executor: MatchExecutor;
}

/**
 * Construct a BulkMatcher with default deps (BrandAliasesRepository -> BrandResolver -> Matcher -> MatchExecutor).
 * Used by ShopCrawler.run() and any caller that wants the standard matching pipeline.
 */
export function createBulkMatcher(shopsDb: ShopsDatabase): BulkMatcher {
    const repo = new BrandAliasesRepository(shopsDb);
    const resolver = new BrandResolver(repo);
    const matcher = new Matcher(shopsDb, resolver);
    const executor = new MatchExecutor({ matcher, shopsDb });
    return new BulkMatcher({ matcher, shopsDb, executor });
}

/**
 * Construct just the per-product MatchExecutor (with all default deps wired) for callers that
 * want to apply the matcher to a single new product — e.g. `tools shops get` ingestion. Avoids
 * the BulkMatcher.flush() machinery (which scans the entire `pending` queue across the DB).
 */
export function createMatchExecutor(shopsDb: ShopsDatabase): MatchExecutor {
    const repo = new BrandAliasesRepository(shopsDb);
    const resolver = new BrandResolver(repo);
    const matcher = new Matcher(shopsDb, resolver);
    return new MatchExecutor({ matcher, shopsDb });
}

export interface BulkMatcherStats {
    linked: number;
    seeded: number;
    grayZone: number;
    candidatesAdded: number;
}

interface PendingRow {
    id: number;
    shop_origin: string;
    name: string;
    name_normalized: string;
    brand: string | null;
    brand_normalized: string | null;
    ean: string | null;
    unit: Unit | null;
    unit_amount: number | null;
    pack_count: number | null;
    flavor_key: string | null;
}

export class BulkMatcher {
    private readonly log;
    constructor(private readonly args: BulkMatcherArgs) {
        this.log = logger.child({
            component: "BulkMatcher",
            instance: Math.random().toString(36).slice(2, 8),
        });
    }

    async flush(crawlRunId: number): Promise<BulkMatcherStats> {
        const log = this.log.child({ crawlRunId });
        const stats: BulkMatcherStats = { linked: 0, seeded: 0, grayZone: 0, candidatesAdded: 0 };
        const candidatesBefore = this.countCandidates();

        this.passEanJoin(stats);
        this.passSignatureJoin(stats);
        await this.passPerProduct(stats);

        const candidatesAfter = this.countCandidates();
        stats.candidatesAdded = candidatesAfter - candidatesBefore;

        const db = this.args.shopsDb.raw();
        db.run(`UPDATE crawl_runs SET candidates_added = candidates_added + ?, status = 'completed' WHERE id = ?`, [
            stats.candidatesAdded,
            crawlRunId,
        ]);

        log.info(stats, "bulk match completed");
        return stats;
    }

    private passEanJoin(stats: BulkMatcherStats): void {
        const db = this.args.shopsDb.raw();
        const rows = db
            .query<{ productId: number; masterId: number; pPack: number | null; mPack: number | null }, []>(
                `SELECT p.id AS productId, m.id AS masterId, p.pack_count AS pPack, m.pack_count AS mPack
                 FROM products p
                 JOIN master_products m ON m.ean = p.ean
                 WHERE p.master_product_id IS NULL AND p.match_method = 'pending' AND p.ean IS NOT NULL
                 ORDER BY p.id ASC`
            )
            .all();
        for (const row of rows) {
            if (!compatPackCount(row.pPack, row.mPack)) {
                continue;
            }

            this.writeLinkedDirect(row.productId, row.masterId, "ean", null);
            stats.linked += 1;
        }
    }

    private passSignatureJoin(stats: BulkMatcherStats): void {
        const db = this.args.shopsDb.raw();
        const rows = db
            .query<
                {
                    productId: number;
                    pShop: string;
                    pName: string;
                    pPack: number | null;
                    masterId: number;
                    mName: string;
                    mPack: number | null;
                },
                []
            >(
                `SELECT p.id AS productId, p.shop_origin AS pShop, p.name_normalized AS pName, p.pack_count AS pPack,
                        m.id AS masterId, m.canonical_name_normalized AS mName, m.pack_count AS mPack
                 FROM products p
                 JOIN master_products m
                   ON m.brand_normalized = p.brand_normalized
                  AND m.unit = p.unit
                  AND m.unit_amount = p.unit_amount
                  AND IFNULL(m.flavor_key, '') = IFNULL(p.flavor_key, '')
                 WHERE p.master_product_id IS NULL AND p.match_method = 'pending'
                   AND p.brand_normalized IS NOT NULL AND p.unit IS NOT NULL AND p.unit_amount IS NOT NULL
                 ORDER BY p.id ASC`
            )
            .all();
        for (const row of rows) {
            if (!compatPackCount(row.pPack, row.mPack)) {
                continue;
            }

            const score = similarityScore(row.pName, row.mName);
            if (score < MATCHER_CONFIG.LAYER1_FUZZY_MIN) {
                continue;
            }

            // Same-shop guard: never link via signature when the master
            // already hosts another active product from this shop. The shop's
            // own slug already separates SKUs (sizes, variants, listings) and
            // we have no EAN here to override that judgment.
            if (this.masterAlreadyHasShop(row.masterId, row.pShop, row.productId)) {
                continue;
            }

            this.writeLinkedDirect(row.productId, row.masterId, "fuzzy", score);
            stats.linked += 1;
        }
    }

    private masterAlreadyHasShop(masterId: number, shopOrigin: string, excludeProductId: number): boolean {
        const row = this.args.shopsDb
            .raw()
            .query<{ id: number }, [number, string, number]>(
                `SELECT id FROM products
                 WHERE master_product_id = ? AND shop_origin = ? AND id != ? AND is_active = 1
                 LIMIT 1`
            )
            .get(masterId, shopOrigin, excludeProductId);
        return row !== null;
    }

    private async passPerProduct(stats: BulkMatcherStats): Promise<void> {
        const db = this.args.shopsDb.raw();
        const rows = db
            .query<PendingRow, []>(
                `SELECT id, shop_origin, name, name_normalized, brand, brand_normalized, ean,
                        unit, unit_amount, pack_count, flavor_key
                 FROM products
                 WHERE master_product_id IS NULL AND match_method = 'pending'
                 ORDER BY id ASC`
            )
            .all();

        for (const row of rows) {
            const input: MatcherInput = {
                productId: row.id,
                shopOrigin: row.shop_origin,
                name: row.name,
                nameNormalized: row.name_normalized,
                brandRaw: row.brand,
                brandNormalized: row.brand_normalized,
                ean: row.ean,
                unit: row.unit,
                unitAmount: row.unit_amount,
                packCount: row.pack_count,
                flavorKey: row.flavor_key,
            };
            const result = await this.args.executor.apply(input);
            if (result.kind === "linked") {
                stats.linked += 1;
            } else if (result.kind === "gray-zone") {
                stats.grayZone += 1;
            } else {
                stats.seeded += 1;
            }
        }
    }

    private writeLinkedDirect(
        productId: number,
        masterProductId: number,
        method: "ean" | "fuzzy",
        similarity: number | null
    ): void {
        const db = this.args.shopsDb.raw();
        const now = new Date().toISOString();
        db.run(
            `UPDATE products SET master_product_id = ?, match_method = ?, match_similarity = ?, match_at = ?, last_updated_at = ?
             WHERE id = ?`,
            [masterProductId, method, similarity, now, now, productId]
        );
        db.run(
            `UPDATE master_products SET total_offers = (
                SELECT COUNT(*) FROM products WHERE master_product_id = ? AND is_active = 1
             ), updated_at = ? WHERE id = ?`,
            [masterProductId, now, masterProductId]
        );
    }

    private countCandidates(): number {
        const row = this.args.shopsDb
            .raw()
            .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM match_candidates")
            .get();
        return row?.n ?? 0;
    }
}
