import logger from "@app/logger";
import { BrandAliasesRepository } from "@app/shops/db/BrandAliasesRepository";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { BrandResolver } from "@app/shops/lib/brand-resolver";
import { MatchExecutor } from "@app/shops/lib/match-executor";
import { Matcher, type MatcherInput } from "@app/shops/lib/matcher";
import { MATCHER_CONFIG } from "@app/shops/lib/matcher-config";
import { compatPackCount } from "@app/shops/lib/multipack-guard";
import { similarityScore } from "@app/utils/fuzzy-match";
import { sql } from "kysely";

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
        const candidatesBefore = await this.countCandidates();

        await this.passEanJoin(stats);
        await this.passSignatureJoin(stats);
        await this.passPerProduct(stats);

        const candidatesAfter = await this.countCandidates();
        stats.candidatesAdded = candidatesAfter - candidatesBefore;

        await this.args.shopsDb
            .kysely()
            .updateTable("crawl_runs")
            .set({
                candidates_added: sql`candidates_added + ${stats.candidatesAdded}`,
                status: "completed" as const,
            })
            .where("id", "=", crawlRunId)
            .execute();

        log.info(stats, "bulk match completed");
        return stats;
    }

    private async passEanJoin(stats: BulkMatcherStats): Promise<void> {
        const rows = await this.args.shopsDb
            .kysely()
            .selectFrom("products as p")
            .innerJoin("master_products as m", "m.ean", "p.ean")
            .select(["p.id as productId", "m.id as masterId", "p.pack_count as pPack", "m.pack_count as mPack"])
            .where("p.master_product_id", "is", null)
            .where("p.match_method", "=", "pending")
            .where("p.ean", "is not", null)
            .orderBy("p.id", "asc")
            .execute();
        for (const row of rows) {
            if (!compatPackCount(row.pPack, row.mPack)) {
                continue;
            }

            await this.writeLinkedDirect(row.productId, row.masterId, "ean", null);
            stats.linked += 1;
        }
    }

    private async passSignatureJoin(stats: BulkMatcherStats): Promise<void> {
        const rows = await this.args.shopsDb
            .kysely()
            .selectFrom("products as p")
            .innerJoin("master_products as m", (join) =>
                join
                    .onRef("m.brand_normalized", "=", "p.brand_normalized")
                    .onRef("m.unit", "=", "p.unit")
                    .onRef("m.unit_amount", "=", "p.unit_amount")
                    .on(sql`IFNULL(m.flavor_key, '') = IFNULL(p.flavor_key, '')`)
            )
            .select([
                "p.id as productId",
                "p.shop_origin as pShop",
                "p.name_normalized as pName",
                "p.pack_count as pPack",
                "m.id as masterId",
                "m.canonical_name_normalized as mName",
                "m.pack_count as mPack",
            ])
            .where("p.master_product_id", "is", null)
            .where("p.match_method", "=", "pending")
            .where("p.brand_normalized", "is not", null)
            .where("p.unit", "is not", null)
            .where("p.unit_amount", "is not", null)
            .orderBy("p.id", "asc")
            .execute();
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
            if (await this.masterAlreadyHasShop(row.masterId, row.pShop, row.productId)) {
                continue;
            }

            await this.writeLinkedDirect(row.productId, row.masterId, "fuzzy", score);
            stats.linked += 1;
        }
    }

    private async masterAlreadyHasShop(
        masterId: number,
        shopOrigin: string,
        excludeProductId: number
    ): Promise<boolean> {
        const row = await this.args.shopsDb
            .kysely()
            .selectFrom("products")
            .select("id")
            .where("master_product_id", "=", masterId)
            .where("shop_origin", "=", shopOrigin)
            .where("id", "!=", excludeProductId)
            .where("is_active", "=", 1)
            .limit(1)
            .executeTakeFirst();
        return row !== undefined;
    }

    private async passPerProduct(stats: BulkMatcherStats): Promise<void> {
        const rows = await this.args.shopsDb
            .kysely()
            .selectFrom("products")
            .select([
                "id",
                "shop_origin",
                "name",
                "name_normalized",
                "brand",
                "brand_normalized",
                "ean",
                "unit",
                "unit_amount",
                "pack_count",
                "flavor_key",
            ])
            .where("master_product_id", "is", null)
            .where("match_method", "=", "pending")
            .orderBy("id", "asc")
            .execute();

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

    private async writeLinkedDirect(
        productId: number,
        masterProductId: number,
        method: "ean" | "fuzzy",
        similarity: number | null
    ): Promise<void> {
        const k = this.args.shopsDb.kysely();
        const now = new Date().toISOString();
        await k
            .updateTable("products")
            .set({
                master_product_id: masterProductId,
                match_method: method,
                match_similarity: similarity,
                match_at: now,
                last_updated_at: now,
            })
            .where("id", "=", productId)
            .execute();
        // Inline denorm update — duplicated from master-denorm.ts by design (out of scope to consolidate).
        await k
            .updateTable("master_products")
            .set((eb) => ({
                total_offers: eb
                    .selectFrom("products")
                    .select((eb2) => eb2.fn.countAll<number>().as("c"))
                    .where("master_product_id", "=", masterProductId)
                    .where("is_active", "=", 1),
                updated_at: now,
            }))
            .where("id", "=", masterProductId)
            .execute();
    }

    private async countCandidates(): Promise<number> {
        const row = await this.args.shopsDb
            .kysely()
            .selectFrom("match_candidates")
            .select((eb) => eb.fn.countAll<number>().as("n"))
            .executeTakeFirst();
        return row?.n ?? 0;
    }
}
