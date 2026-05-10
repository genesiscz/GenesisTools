import logger from "@app/logger";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { refreshMasterDenorm } from "@app/shops/lib/master-denorm";
import type { Matcher, MatcherInput, MatchResult } from "@app/shops/lib/matcher";
import { slugify } from "@app/utils/string";

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

        // uniqueSlug + INSERT race when two BulkMatcher.flush runs (e.g.
        // parallel sitemap-crawls) pick the same free slug between
        // SELECT-vs-INSERT. SQLite serializes the writes but the SELECT in
        // uniqueSlug ran in the loser's read snapshot, so it didn't see the
        // winner's row. Catch the UNIQUE error, re-run uniqueSlug (which
        // now sees the winner's row), retry. Capped to avoid pathological
        // hammering on a hot baseSlug.
        let masterId = -1;
        let lastError: unknown = null;
        for (let attempt = 0; attempt < 5; attempt++) {
            const slug = this.uniqueSlug(baseSlug);
            try {
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

                masterId = row.id;
                break;
            } catch (err) {
                lastError = err;
                if (!isUniqueSlugError(err)) {
                    throw err;
                }

                log.warn(
                    { baseSlug, slug, attempt: attempt + 1 },
                    "master_products canonical_slug collision; retrying"
                );
            }
        }

        if (masterId === -1) {
            throw lastError ?? new Error(`unable to seed master after retries (baseSlug=${baseSlug})`);
        }
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
        refreshMasterDenorm(this.args.shopsDb.raw(), masterId);
    }
}

function isUniqueSlugError(err: unknown): boolean {
    if (!(err instanceof Error)) {
        return false;
    }

    const message = err.message;
    return (
        message.includes("UNIQUE constraint failed: master_products.canonical_slug") ||
        message.includes("SQLITE_CONSTRAINT_UNIQUE")
    );
}
