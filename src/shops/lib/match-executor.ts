import { logger } from "@app/logger";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { MatchCandidatesTable } from "@app/shops/db/types";
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
                await this.writeLinked(input.productId, result.masterProductId, result.method, result.similarity);
                break;
            case "seed":
                await this.writeSeed(input);
                break;
            case "gray-zone":
                await this.writeGrayZone(input.productId, result.candidateProductId, result.method, result.similarity);
                break;
        }

        return result;
    }

    private async writeLinked(
        productId: number,
        masterProductId: number,
        method: "ean" | "fuzzy" | "sig:no-flavor" | "sig:no-size" | "fuzzy-brand-name",
        similarity: number | null
    ): Promise<void> {
        const now = new Date().toISOString();
        await this.args.shopsDb
            .kysely()
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
        await refreshMasterDenorm(this.args.shopsDb, masterProductId);
    }

    private async writeSeed(input: MatcherInput): Promise<number> {
        const k = this.args.shopsDb.kysely();
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
            const slug = await this.uniqueSlug(baseSlug);
            try {
                const inserted = await k
                    .insertInto("master_products")
                    .values({
                        canonical_name: input.name,
                        canonical_name_normalized: input.nameNormalized,
                        canonical_slug: slug,
                        brand: input.brandRaw,
                        brand_normalized: input.brandNormalized,
                        ean: input.ean,
                        unit: input.unit,
                        unit_amount: input.unitAmount,
                        pack_count: input.packCount,
                        flavor_key: input.flavorKey,
                        total_offers: 0,
                        created_at: now,
                        updated_at: now,
                        verified_by: "auto",
                    })
                    .returning("id")
                    .executeTakeFirstOrThrow();
                masterId = inserted.id;
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

        await k
            .updateTable("products")
            .set({
                master_product_id: masterId,
                match_method: "auto-seed",
                match_similarity: null,
                match_at: now,
                last_updated_at: now,
            })
            .where("id", "=", input.productId)
            .execute();
        await refreshMasterDenorm(this.args.shopsDb, masterId);
        log.debug({ productId: input.productId, masterId }, "auto-seeded master");
        return masterId;
    }

    private async writeGrayZone(
        productId: number,
        candidateProductId: number,
        method: string,
        similarity: number
    ): Promise<void> {
        const k = this.args.shopsDb.kysely();
        const now = new Date().toISOString();
        const lo = Math.min(productId, candidateProductId);
        const hi = Math.max(productId, candidateProductId);

        await k
            .updateTable("products")
            .set({ match_method: "gray-zone", match_at: now, last_updated_at: now })
            .where("id", "=", productId)
            .execute();
        await k
            .insertInto("match_candidates")
            .values({
                product_id_a: lo,
                product_id_b: hi,
                similarity,
                match_method: method as MatchCandidatesTable["match_method"],
                created_at: now,
            })
            .onConflict((oc) => oc.columns(["product_id_a", "product_id_b"]).doNothing())
            .execute();
    }

    private async uniqueSlug(base: string): Promise<string> {
        let candidate = base;
        for (let suffix = 2; suffix < 1000; suffix++) {
            const existing = await this.args.shopsDb
                .kysely()
                .selectFrom("master_products")
                .select("id")
                .where("canonical_slug", "=", candidate)
                .executeTakeFirst();
            if (!existing) {
                return candidate;
            }

            candidate = `${base}-${suffix}`;
        }

        throw new Error(`Could not allocate unique canonical_slug for ${base}`);
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
