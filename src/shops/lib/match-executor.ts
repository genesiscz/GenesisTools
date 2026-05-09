import logger from "@app/logger";
import { slugify } from "@app/utils/string";
import type { ShopsDatabase } from "../db/ShopsDatabase";
import type { Matcher, MatcherInput, MatchResult } from "./matcher";

export type { MatchResult };

const log = logger.child({
    component: "MatchExecutor",
    instance: Math.random().toString(36).slice(2, 8),
});

export interface MatchExecutorArgs {
    matcher: Matcher;
    shopsDb: ShopsDatabase;
}

export class MatchExecutor {
    constructor(private readonly args: MatchExecutorArgs) {}

    async apply(input: MatcherInput): Promise<MatchResult> {
        const result = await this.args.matcher.match(input);
        switch (result.kind) {
            case "linked":
                this.writeLinked(input.productId, result.masterProductId, result.method, result.similarity);
                break;
            case "seed":
                this.writeSeed(input);
                break;
            case "gray-zone":
                this.writeGrayZone(input.productId, result.candidateProductId, result.method, result.similarity);
                break;
        }

        return result;
    }

    private writeLinked(
        productId: number,
        masterProductId: number,
        method: "ean" | "fuzzy" | "sig:no-flavor" | "sig:no-size" | "fuzzy-brand-name",
        similarity: number | null
    ): void {
        const db = this.args.shopsDb.raw();
        const now = new Date().toISOString();
        db.run(
            `UPDATE products SET master_product_id = ?, match_method = ?, match_similarity = ?, match_at = ?, last_updated_at = ?
             WHERE id = ?`,
            [masterProductId, method, similarity, now, now, productId]
        );
        this.refreshMasterDenorm(masterProductId);
    }

    private writeSeed(input: MatcherInput): number {
        const db = this.args.shopsDb.raw();
        const now = new Date().toISOString();
        const baseSlug = slugify(input.name) || `master-${Date.now()}`;
        const slug = this.uniqueSlug(baseSlug);
        db.run(
            `INSERT INTO master_products
             (canonical_name, canonical_name_normalized, canonical_slug,
              brand, brand_normalized, ean, unit, unit_amount, pack_count, flavor_key,
              total_offers, created_at, updated_at, verified_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'auto')`,
            [
                input.name,
                input.nameNormalized,
                slug,
                input.brandRaw,
                input.brandNormalized,
                input.ean,
                input.unit,
                input.unitAmount,
                input.packCount,
                input.flavorKey,
                now,
                now,
            ]
        );
        const row = db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get();
        if (!row) {
            throw new Error("master_products insert failed");
        }
        const masterId = row.id;
        db.run(
            `UPDATE products SET master_product_id = ?, match_method = 'auto-seed', match_similarity = NULL, match_at = ?, last_updated_at = ?
             WHERE id = ?`,
            [masterId, now, now, input.productId]
        );
        this.refreshMasterDenorm(masterId);
        log.debug({ productId: input.productId, masterId }, "auto-seeded master");
        return masterId;
    }

    private writeGrayZone(productId: number, candidateProductId: number, method: string, similarity: number): void {
        const db = this.args.shopsDb.raw();
        const now = new Date().toISOString();
        const lo = Math.min(productId, candidateProductId);
        const hi = Math.max(productId, candidateProductId);
        db.run(`UPDATE products SET match_method = 'gray-zone', match_at = ?, last_updated_at = ? WHERE id = ?`, [
            now,
            now,
            productId,
        ]);
        db.run(
            `INSERT OR IGNORE INTO match_candidates
             (product_id_a, product_id_b, similarity, match_method, status, created_at)
             VALUES (?, ?, ?, ?, 'pending', ?)`,
            [lo, hi, similarity, method, now]
        );
    }

    private uniqueSlug(base: string): string {
        const db = this.args.shopsDb.raw();
        let candidate = base;
        for (let suffix = 2; suffix < 1000; suffix++) {
            const existing = db
                .query<{ id: number }, [string]>("SELECT id FROM master_products WHERE canonical_slug = ?")
                .get(candidate);
            if (!existing) {
                return candidate;
            }

            candidate = `${base}-${suffix}`;
        }

        throw new Error(`Could not allocate unique canonical_slug for ${base}`);
    }

    private refreshMasterDenorm(masterId: number): void {
        const db = this.args.shopsDb.raw();
        const now = new Date().toISOString();
        // Inherit a representative image from any linked product when the master
        // doesn't have one yet. Fixes the /browse "no images" issue without
        // demoting curated images that were already set.
        db.run(
            `UPDATE master_products SET
                total_offers = (
                    SELECT COUNT(*) FROM products WHERE master_product_id = ? AND is_active = 1
                ),
                representative_image_url = COALESCE(
                    representative_image_url,
                    (SELECT image_url FROM products
                       WHERE master_product_id = ? AND is_active = 1 AND image_url IS NOT NULL
                       ORDER BY id LIMIT 1)
                ),
                updated_at = ?
             WHERE id = ?`,
            [masterId, masterId, now, masterId]
        );
    }
}
