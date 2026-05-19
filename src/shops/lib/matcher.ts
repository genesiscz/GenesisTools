import { logger } from "@app/logger";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { MasterProduct } from "@app/shops/db/types";
import type { BrandResolver } from "@app/shops/lib/brand-resolver";
import { isLayer3GrayZone, MATCHER_CONFIG, type MatcherConfig } from "@app/shops/lib/matcher-config";
import { compatPackCount } from "@app/shops/lib/multipack-guard";
import type { Unit } from "@app/shops/lib/normalize";
import { similarityScore, wordSimilarity } from "@app/utils/fuzzy-match";

function tokenize(s: string): Set<string> {
    // Strip Unicode punctuation/symbols per token so trivial differences
    // (e.g. "Zott Hungry?" vs "Zott Hungry") don't drop the intersection
    // count and tank fuzzy similarity for cross-shop matching.
    return new Set(
        s
            .split(/\s+/)
            .map((t) => t.replace(/[^\p{L}\p{N}]+/gu, ""))
            .filter((t) => t.length > 0)
    );
}

function containmentSimilarity(a: string, b: string): number {
    const wa = tokenize(a);
    const wb = tokenize(b);
    if (wa.size === 0 || wb.size === 0) {
        return 0;
    }

    const [small, big] = wa.size < wb.size ? [wa, wb] : [wb, wa];
    let inter = 0;
    for (const t of small) {
        if (big.has(t)) {
            inter += 1;
        }
    }

    return inter / small.size;
}

function combinedNameSimilarity(a: string, b: string): number {
    return Math.max(similarityScore(a, b), wordSimilarity(a, b), containmentSimilarity(a, b) * 0.95);
}

export interface MatcherInput {
    productId: number;
    shopOrigin: string;
    name: string;
    nameNormalized: string;
    brandRaw: string | null;
    brandNormalized: string | null;
    ean: string | null;
    unit: Unit | null;
    unitAmount: number | null;
    packCount: number | null;
    flavorKey: string | null;
}

export type MatchResult =
    | {
          kind: "linked";
          masterProductId: number;
          method: "ean" | "fuzzy" | "sig:no-flavor" | "sig:no-size" | "fuzzy-brand-name";
          similarity: number | null;
          layer: 0 | 1 | 2 | 3;
      }
    | { kind: "seed"; reason: "no-candidate" }
    | {
          kind: "gray-zone";
          candidateProductId: number;
          candidateMasterProductId: number | null;
          method: "fuzzy-brand-name" | "sig:no-flavor" | "sig:no-size" | "fuzzy";
          similarity: number;
          layer: 3 | 4;
      };

export class Matcher {
    private readonly log;

    constructor(
        private readonly shopsDb: ShopsDatabase,
        readonly resolver: BrandResolver,
        private readonly config: MatcherConfig = MATCHER_CONFIG
    ) {
        this.log = logger.child({
            component: "Matcher",
            instance: Math.random().toString(36).slice(2, 8),
        });
    }

    async match(input: MatcherInput): Promise<MatchResult> {
        const log = this.log.child({ shop: input.shopOrigin, productId: input.productId });

        const l0 = await this.layer0(input);
        if (l0) {
            log.info({ layer: 0, masterId: l0.kind === "linked" ? l0.masterProductId : null }, "matched at layer 0");
            return l0;
        }

        const l1 = await this.layer1(input);
        if (l1) {
            log.info({ layer: 1 }, "matched at layer 1");
            return l1;
        }

        const l2a = await this.layer2a(input);
        if (l2a) {
            log.info({ layer: 2 }, "matched at layer 2a");
            return l2a;
        }

        const l2b = await this.layer2b(input);
        if (l2b) {
            log.info({ layer: 2 }, "matched at layer 2b");
            return l2b;
        }

        const l3 = await this.layer3(input);
        if (l3) {
            log.info({ layer: 3, kind: l3.kind }, "matched at layer 3");
            return l3;
        }

        const l4 = await this.layer4(input);
        if (l4) {
            log.info({ layer: 4, kind: l4.kind }, "matched at layer 4");
            return l4;
        }

        log.debug("no candidate at any layer; will seed");
        return { kind: "seed", reason: "no-candidate" };
    }

    /**
     * Drop masters that already host an *active* product from the same shop as
     * the input. Two products from the same shop with different slugs are
     * different SKUs by construction, even when their names look identical —
     * shops use the slug to differentiate sizes/variants and we have no
     * ground-truth to merge them without an EAN.
     *
     * Real cases this catches:
     * - "7Days Croissant s kakaovou náplní" vs "Mini" vs "5×37g multipack"
     *   (different names, same brand, fuzzy-linked at 0.95 → all rohlik).
     * - "Medovník originál classic" listed 4× under one master from the same
     *   shop at 43.90 / 134.90 / 269.90 / 519.90 Kč (different sizes, identical
     *   normalized name).
     *
     * EAN matches (Layer 0) bypass the guard via `bypassSameShopBlock=true`
     * because EAN is ground-truth — same EAN + same shop = real duplicate.
     */
    private async filterSameShopMasters(
        rows: MasterProduct[],
        input: MatcherInput,
        bypassSameShopBlock = false
    ): Promise<MasterProduct[]> {
        if (rows.length === 0 || bypassSameShopBlock) {
            return rows;
        }

        const taken = await this.collectSameShopMasterIds(input);
        if (taken.size === 0) {
            return rows;
        }

        return rows.filter((m) => !taken.has(m.id));
    }

    private async collectSameShopMasterIds(input: MatcherInput): Promise<Set<number>> {
        const taken = await this.shopsDb
            .kysely()
            .selectFrom("products")
            .select("master_product_id")
            .distinct()
            .where("shop_origin", "=", input.shopOrigin)
            .where("id", "!=", input.productId)
            .where("is_active", "=", 1)
            .where("master_product_id", "is not", null)
            .execute();
        return new Set(taken.map((t) => t.master_product_id).filter((x): x is number => x !== null));
    }

    private async isRejectedPair(productIdA: number, productIdB: number): Promise<boolean> {
        const lo = Math.min(productIdA, productIdB);
        const hi = Math.max(productIdA, productIdB);
        const row = await this.shopsDb
            .kysely()
            .selectFrom("match_candidates")
            .select("status")
            .where("product_id_a", "=", lo)
            .where("product_id_b", "=", hi)
            .where("status", "=", "rejected")
            .executeTakeFirst();
        return row !== undefined;
    }

    private async layer0(input: MatcherInput): Promise<MatchResult | null> {
        if (input.ean === null) {
            return null;
        }

        const rows = await this.shopsDb
            .kysely()
            .selectFrom("master_products")
            .selectAll()
            .where("ean", "=", input.ean)
            .execute();

        // EAN match is ground-truth across shops AND same-shop duplicates,
        // so bypass the same-shop guard at this layer.
        const allowed = await this.filterSameShopMasters(rows, input, true);
        const compat = allowed.filter((m) => compatPackCount(input.packCount, m.pack_count));
        if (compat.length === 0) {
            return null;
        }

        const chosen = compat.sort((a, b) => a.id - b.id)[0];
        return {
            kind: "linked",
            masterProductId: chosen.id,
            method: "ean",
            similarity: null,
            layer: 0,
        };
    }

    private async layer1(input: MatcherInput): Promise<MatchResult | null> {
        if (
            input.brandNormalized === null ||
            input.unit === null ||
            input.unitAmount === null ||
            input.flavorKey === null
        ) {
            return null;
        }

        const rows = await this.shopsDb
            .kysely()
            .selectFrom("master_products")
            .selectAll()
            .where("brand_normalized", "=", input.brandNormalized)
            .where("unit", "=", input.unit)
            .where("unit_amount", "=", input.unitAmount)
            .where("flavor_key", "=", input.flavorKey)
            .execute();
        return this.bestFuzzy(
            input,
            await this.filterSameShopMasters(rows, input),
            this.config.LAYER1_FUZZY_MIN,
            "fuzzy",
            1
        );
    }

    private async layer2a(input: MatcherInput): Promise<MatchResult | null> {
        if (input.brandNormalized === null || input.unit === null || input.unitAmount === null) {
            return null;
        }

        const rows = await this.shopsDb
            .kysely()
            .selectFrom("master_products")
            .selectAll()
            .where("brand_normalized", "=", input.brandNormalized)
            .where("unit", "=", input.unit)
            .where("unit_amount", "=", input.unitAmount)
            .execute();
        const filtered = await this.filterSameShopMasters(rows, input);
        const eligible = filtered.filter((m) => m.flavor_key === null || input.flavorKey === null);
        return this.bestFuzzy(input, eligible, this.config.LAYER2A_FUZZY_MIN, "sig:no-flavor", 2);
    }

    private async layer2b(input: MatcherInput): Promise<MatchResult | null> {
        if (input.brandNormalized === null || input.flavorKey === null) {
            return null;
        }

        const rows = await this.shopsDb
            .kysely()
            .selectFrom("master_products")
            .selectAll()
            .where("brand_normalized", "=", input.brandNormalized)
            .where("flavor_key", "=", input.flavorKey)
            .execute();
        const filtered = await this.filterSameShopMasters(rows, input);
        const eligible = filtered.filter((m) => m.unit === null || input.unit === null);
        return this.bestFuzzy(input, eligible, this.config.LAYER2B_FUZZY_MIN, "sig:no-size", 2);
    }

    private async layer3(input: MatcherInput): Promise<MatchResult | null> {
        if (input.brandNormalized === null) {
            return null;
        }

        const rows = await this.shopsDb
            .kysely()
            .selectFrom("master_products")
            .selectAll()
            .where("brand_normalized", "=", input.brandNormalized)
            .execute();

        const allowed = await this.filterSameShopMasters(rows, input);
        const compat = allowed.filter((m) => compatPackCount(input.packCount, m.pack_count));
        if (compat.length === 0) {
            return null;
        }

        let best: { row: MasterProduct; score: number } | null = null;
        for (const row of compat) {
            const score = combinedNameSimilarity(input.nameNormalized, row.canonical_name_normalized);
            if (best === null || score > best.score) {
                best = { row, score };
            }
        }

        if (best === null) {
            return null;
        }

        if (best.score >= this.config.LAYER3_AUTOLINK_MIN) {
            return {
                kind: "linked",
                masterProductId: best.row.id,
                method: "fuzzy-brand-name",
                similarity: best.score,
                layer: 3,
            };
        }

        if (isLayer3GrayZone(best.score)) {
            const candidate = await this.findCandidateProductForMaster(best.row.id, input.productId);
            if (candidate === null) {
                return null;
            }

            return {
                kind: "gray-zone",
                candidateProductId: candidate,
                candidateMasterProductId: best.row.id,
                method: "fuzzy-brand-name",
                similarity: best.score,
                layer: 3,
            };
        }

        // Relaxed cross-shop gray-zone: same brand + strong one-way containment
        // (one name's tokens are mostly a subset of the other's). Catches the
        // "long Czech canonical name" vs "short English variant name" pattern
        // where a product's two listings on different shops genuinely look
        // very different to fuzzy similarity (e.g. "Zott Hungry? Drink This!
        // Nápoj s čokoládovou příchutí" vs "Zott Hungry Drink Choco" scores
        // 0.71 overall but containment is 0.75). Gray-zone only — never
        // auto-link, since false-positive risk is real.
        if (
            best.score >= this.config.LAYER3_CROSS_SHOP_CONTAINMENT_MIN &&
            containmentSimilarity(input.nameNormalized, best.row.canonical_name_normalized) >=
                this.config.LAYER3_CROSS_SHOP_CONTAINMENT_MIN
        ) {
            const candidate = await this.findCandidateProductForMaster(best.row.id, input.productId);
            if (candidate === null) {
                return null;
            }

            return {
                kind: "gray-zone",
                candidateProductId: candidate,
                candidateMasterProductId: best.row.id,
                method: "fuzzy-brand-name",
                similarity: best.score,
                layer: 3,
            };
        }

        return null;
    }

    private async layer4(input: MatcherInput): Promise<MatchResult | null> {
        if (input.brandNormalized !== null) {
            return null;
        }

        const allMasters = await this.shopsDb.kysely().selectFrom("master_products").selectAll().execute();
        const candidates = await this.filterSameShopMasters(allMasters, input);

        let best: { row: MasterProduct; score: number } | null = null;
        for (const row of candidates) {
            if (!compatPackCount(input.packCount, row.pack_count)) {
                continue;
            }

            const left = `${input.brandRaw ?? ""} ${input.nameNormalized}`.trim();
            const right = `${row.brand_normalized ?? ""} ${row.canonical_name_normalized}`.trim();
            const score = wordSimilarity(left, right);
            if (best === null || score > best.score) {
                best = { row, score };
            }
        }

        if (best === null || best.score < this.config.LAYER4_CANDIDATE_MIN) {
            return null;
        }

        const candidate = await this.findCandidateProductForMaster(best.row.id, input.productId);
        if (candidate === null) {
            return null;
        }

        return {
            kind: "gray-zone",
            candidateProductId: candidate,
            candidateMasterProductId: best.row.id,
            method: "fuzzy",
            similarity: best.score,
            layer: 4,
        };
    }

    private bestFuzzy(
        input: MatcherInput,
        rows: MasterProduct[],
        minScore: number,
        method: "fuzzy" | "sig:no-flavor" | "sig:no-size",
        layer: 1 | 2
    ): MatchResult | null {
        const compat = rows.filter((m) => compatPackCount(input.packCount, m.pack_count));
        if (compat.length === 0) {
            return null;
        }

        let best: { row: MasterProduct; score: number } | null = null;
        for (const row of compat) {
            const score = combinedNameSimilarity(input.nameNormalized, row.canonical_name_normalized);
            if (best === null || score > best.score) {
                best = { row, score };
            }
        }

        if (best === null || best.score < minScore) {
            return null;
        }

        return {
            kind: "linked",
            masterProductId: best.row.id,
            method,
            similarity: best.score,
            layer,
        };
    }

    private async findCandidateProductForMaster(
        masterProductId: number,
        inputProductId: number
    ): Promise<number | null> {
        const rows = await this.shopsDb
            .kysely()
            .selectFrom("products")
            .select("id")
            .where("master_product_id", "=", masterProductId)
            .where("is_active", "=", 1)
            .orderBy("id", "asc")
            .execute();

        for (const row of rows) {
            if (!(await this.isRejectedPair(inputProductId, row.id))) {
                return row.id;
            }
        }

        return null;
    }
}
