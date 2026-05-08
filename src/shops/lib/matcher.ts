import logger from "@app/logger";
import { similarityScore, wordSimilarity } from "@app/utils/fuzzy-match";
import type { ShopsDatabase } from "../db/ShopsDatabase";
import type { BrandResolver } from "./brand-resolver";
import { isLayer3GrayZone, MATCHER_CONFIG, type MatcherConfig } from "./matcher-config";
import { compatPackCount } from "./multipack-guard";
import type { Unit } from "./normalize";

function tokenize(s: string): Set<string> {
    return new Set(s.split(/\s+/).filter((t) => t.length > 0));
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

interface MasterRow {
    id: number;
    canonical_name_normalized: string;
    brand_normalized: string | null;
    ean: string | null;
    unit: Unit | null;
    unit_amount: number | null;
    pack_count: number | null;
    flavor_key: string | null;
}

const MASTER_COLS = `id, canonical_name_normalized, brand_normalized, ean, unit, unit_amount, pack_count, flavor_key`;

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

        const l0 = this.layer0(input);
        if (l0) {
            log.info({ layer: 0, masterId: l0.kind === "linked" ? l0.masterProductId : null }, "matched at layer 0");
            return l0;
        }

        const l1 = this.layer1(input);
        if (l1) {
            log.info({ layer: 1 }, "matched at layer 1");
            return l1;
        }

        const l2a = this.layer2a(input);
        if (l2a) {
            log.info({ layer: 2 }, "matched at layer 2a");
            return l2a;
        }

        const l2b = this.layer2b(input);
        if (l2b) {
            log.info({ layer: 2 }, "matched at layer 2b");
            return l2b;
        }

        const l3 = this.layer3(input);
        if (l3) {
            log.info({ layer: 3, kind: l3.kind }, "matched at layer 3");
            return l3;
        }

        const l4 = this.layer4(input);
        if (l4) {
            log.info({ layer: 4, kind: l4.kind }, "matched at layer 4");
            return l4;
        }

        log.debug("no candidate at any layer; will seed");
        return { kind: "seed", reason: "no-candidate" };
    }

    private isRejectedPair(productIdA: number, productIdB: number): boolean {
        const lo = Math.min(productIdA, productIdB);
        const hi = Math.max(productIdA, productIdB);
        const row = this.shopsDb
            .raw()
            .query<{ status: string }, [number, number]>(
                "SELECT status FROM match_candidates WHERE product_id_a = ? AND product_id_b = ? AND status = 'rejected'"
            )
            .get(lo, hi);
        return row !== null;
    }

    private layer0(input: MatcherInput): MatchResult | null {
        if (input.ean === null) {
            return null;
        }

        const rows = this.shopsDb
            .raw()
            .query<MasterRow, [string]>(`SELECT ${MASTER_COLS} FROM master_products WHERE ean = ?`)
            .all(input.ean);

        const compat = rows.filter((m) => compatPackCount(input.packCount, m.pack_count));
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

    private layer1(input: MatcherInput): MatchResult | null {
        if (
            input.brandNormalized === null ||
            input.unit === null ||
            input.unitAmount === null ||
            input.flavorKey === null
        ) {
            return null;
        }

        const rows = this.shopsDb
            .raw()
            .query<MasterRow, [string, string, number, string]>(
                `SELECT ${MASTER_COLS} FROM master_products
                 WHERE brand_normalized = ? AND unit = ? AND unit_amount = ? AND flavor_key = ?`
            )
            .all(input.brandNormalized, input.unit, input.unitAmount, input.flavorKey);
        return this.bestFuzzy(input, rows, this.config.LAYER1_FUZZY_MIN, "fuzzy", 1);
    }

    private layer2a(input: MatcherInput): MatchResult | null {
        if (input.brandNormalized === null || input.unit === null || input.unitAmount === null) {
            return null;
        }

        const rows = this.shopsDb
            .raw()
            .query<MasterRow, [string, string, number]>(
                `SELECT ${MASTER_COLS} FROM master_products
                 WHERE brand_normalized = ? AND unit = ? AND unit_amount = ?`
            )
            .all(input.brandNormalized, input.unit, input.unitAmount);
        const eligible = rows.filter((m) => m.flavor_key === null || input.flavorKey === null);
        return this.bestFuzzy(input, eligible, this.config.LAYER2A_FUZZY_MIN, "sig:no-flavor", 2);
    }

    private layer2b(input: MatcherInput): MatchResult | null {
        if (input.brandNormalized === null || input.flavorKey === null) {
            return null;
        }

        const rows = this.shopsDb
            .raw()
            .query<MasterRow, [string, string]>(
                `SELECT ${MASTER_COLS} FROM master_products
                 WHERE brand_normalized = ? AND flavor_key = ?`
            )
            .all(input.brandNormalized, input.flavorKey);
        const eligible = rows.filter((m) => m.unit === null || input.unit === null);
        return this.bestFuzzy(input, eligible, this.config.LAYER2B_FUZZY_MIN, "sig:no-size", 2);
    }

    private layer3(input: MatcherInput): MatchResult | null {
        if (input.brandNormalized === null) {
            return null;
        }

        const rows = this.shopsDb
            .raw()
            .query<MasterRow, [string]>(`SELECT ${MASTER_COLS} FROM master_products WHERE brand_normalized = ?`)
            .all(input.brandNormalized);

        const compat = rows.filter((m) => compatPackCount(input.packCount, m.pack_count));
        if (compat.length === 0) {
            return null;
        }

        let best: { row: MasterRow; score: number } | null = null;
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
            const candidate = this.findCandidateProductForMaster(best.row.id, input.productId);
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

    private layer4(input: MatcherInput): MatchResult | null {
        if (input.brandNormalized !== null) {
            return null;
        }

        const candidates = this.shopsDb.raw().query<MasterRow, []>(`SELECT ${MASTER_COLS} FROM master_products`).all();

        let best: { row: MasterRow; score: number } | null = null;
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

        const candidate = this.findCandidateProductForMaster(best.row.id, input.productId);
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
        rows: MasterRow[],
        minScore: number,
        method: "fuzzy" | "sig:no-flavor" | "sig:no-size",
        layer: 1 | 2
    ): MatchResult | null {
        const compat = rows.filter((m) => compatPackCount(input.packCount, m.pack_count));
        if (compat.length === 0) {
            return null;
        }

        let best: { row: MasterRow; score: number } | null = null;
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

    private findCandidateProductForMaster(masterProductId: number, inputProductId: number): number | null {
        const rows = this.shopsDb
            .raw()
            .query<{ id: number }, [number]>(
                `SELECT id FROM products
                 WHERE master_product_id = ? AND is_active = 1
                 ORDER BY id ASC`
            )
            .all(masterProductId);

        for (const row of rows) {
            if (!this.isRejectedPair(inputProductId, row.id)) {
                return row.id;
            }
        }

        return null;
    }
}
