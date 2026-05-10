import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrandAliasesRepository } from "@app/shops/db/BrandAliasesRepository";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { BrandResolver } from "@app/shops/lib/brand-resolver";
import { MatchExecutor } from "@app/shops/lib/match-executor";
import { Matcher, type MatcherInput } from "@app/shops/lib/matcher";
import {
    extractFlavorKey,
    extractPackCount,
    extractSize,
    normalizeBrand,
    normalizeName,
} from "@app/shops/lib/normalize";
import { SafeJSON } from "@app/utils/json";

interface FixtureProduct {
    shop_origin: string;
    url: string;
    name: string;
    brand: string | null;
    ean: string | null;
}

interface FixtureEntry {
    description: string;
    expected_master_group: FixtureProduct[];
    expected_separate_groups: FixtureProduct[][];
}

export interface PairOutcome {
    a: FixtureProduct;
    b: FixtureProduct;
    expectedSame: boolean;
    actualSame: boolean;
    aMaster: number | null;
    bMaster: number | null;
}

export interface GoldenSummary {
    totalPairs: number;
    truePositive: number;
    falsePositive: number;
    falseNegative: number;
    trueNegative: number;
    precision: number;
    recall: number;
    f1: number;
    misclassifications: PairOutcome[];
}

export interface GoldenHarnessOptions {
    fixturePath?: string;
}

export async function runGoldenHarness(opts: GoldenHarnessOptions = {}): Promise<GoldenSummary> {
    const fixturePath = opts.fixturePath ?? join(process.cwd(), "tests", "fixtures", "matching", "golden-pairs.json");
    const fixtures = SafeJSON.parse(readFileSync(fixturePath, "utf8")) as FixtureEntry[];

    const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-golden-")), "test.db"));
    seedShops(db, fixtures);

    const repo = new BrandAliasesRepository(db);
    seedBrandAliases(repo, fixtures);
    const resolver = new BrandResolver(repo);
    const matcher = new Matcher(db, resolver);
    const executor = new MatchExecutor({ matcher, shopsDb: db });

    const labeled = await ingestFixtures(db, executor, fixtures);

    const result = computePairMetrics(labeled);
    db.close();
    return result;
}

interface LabeledProduct {
    productId: number;
    masterId: number | null;
    expectedGroup: string;
    fixture: FixtureProduct;
}

function seedShops(db: ShopsDatabase, fixtures: FixtureEntry[]): void {
    const origins = new Set<string>();
    for (const entry of fixtures) {
        for (const p of entry.expected_master_group) {
            origins.add(p.shop_origin);
        }

        for (const group of entry.expected_separate_groups) {
            for (const p of group) {
                origins.add(p.shop_origin);
            }
        }
    }

    for (const origin of origins) {
        db.raw().run(
            `INSERT OR IGNORE INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
             VALUES (?, ?, 'CZK', 1, 1, 1, 1, 1, 'none')`,
            [origin, origin]
        );
    }
}

function seedBrandAliases(repo: BrandAliasesRepository, fixtures: FixtureEntry[]): void {
    const brands = new Set<string>();
    for (const entry of fixtures) {
        for (const p of [...entry.expected_master_group, ...entry.expected_separate_groups.flat()]) {
            if (p.brand) {
                brands.add(p.brand);
            }
        }
    }

    for (const brand of brands) {
        const canonical = normalizeBrand(brand);
        if (canonical) {
            repo.upsertIfAbsent({ alias: brand, canonical, source: "seed" });
        }
    }
}

async function ingestFixtures(
    db: ShopsDatabase,
    executor: MatchExecutor,
    fixtures: FixtureEntry[]
): Promise<LabeledProduct[]> {
    const labeled: LabeledProduct[] = [];

    let groupIdx = 0;
    for (const entry of fixtures) {
        if (entry.expected_master_group.length > 0) {
            const groupId = `entry-${groupIdx}-master`;
            for (const fp of entry.expected_master_group) {
                const labeledRow = await ingestOne(db, executor, fp, groupId);
                labeled.push(labeledRow);
            }
        }

        let sepIdx = 0;
        for (const group of entry.expected_separate_groups) {
            const groupId = `entry-${groupIdx}-sep-${sepIdx}`;
            for (const fp of group) {
                const labeledRow = await ingestOne(db, executor, fp, groupId);
                labeled.push(labeledRow);
            }
            sepIdx += 1;
        }

        groupIdx += 1;
    }

    return labeled;
}

let productCounter = 0;
async function ingestOne(
    db: ShopsDatabase,
    executor: MatchExecutor,
    fp: FixtureProduct,
    expectedGroup: string
): Promise<LabeledProduct> {
    productCounter += 1;
    const now = new Date().toISOString();
    const nameNormalized = normalizeName(fp.name);
    const brandNormalized = normalizeBrand(fp.brand);
    const size = extractSize(fp.name);
    const packCount = extractPackCount(fp.name);
    const flavorKey = extractFlavorKey(fp.name);

    db.raw().run(
        `INSERT INTO products
         (shop_origin, slug, url, name, name_normalized, brand, brand_normalized, ean,
          unit, unit_amount, pack_count, flavor_key,
          match_method, first_seen_at, last_updated_at, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1)`,
        [
            fp.shop_origin,
            `golden-${productCounter}`,
            fp.url,
            fp.name,
            nameNormalized,
            fp.brand,
            brandNormalized,
            fp.ean,
            size?.unit ?? null,
            size?.unitAmount ?? null,
            packCount,
            flavorKey,
            now,
            now,
        ]
    );
    const row = db.raw().query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get();
    if (!row) {
        throw new Error("product insert failed");
    }
    const productId = row.id;

    const input: MatcherInput = {
        productId,
        shopOrigin: fp.shop_origin,
        name: fp.name,
        nameNormalized,
        brandRaw: fp.brand,
        brandNormalized,
        ean: fp.ean,
        unit: size?.unit ?? null,
        unitAmount: size?.unitAmount ?? null,
        packCount,
        flavorKey,
    };

    await executor.apply(input);

    const final = db
        .raw()
        .query<{ master_product_id: number | null }, [number]>("SELECT master_product_id FROM products WHERE id = ?")
        .get(productId);
    return {
        productId,
        masterId: final?.master_product_id ?? null,
        expectedGroup,
        fixture: fp,
    };
}

function computePairMetrics(labeled: LabeledProduct[]): GoldenSummary {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    const misclassifications: PairOutcome[] = [];

    for (let i = 0; i < labeled.length; i++) {
        for (let j = i + 1; j < labeled.length; j++) {
            const a = labeled[i];
            const b = labeled[j];
            const expectedSame = a.expectedGroup === b.expectedGroup;
            const actualSame = a.masterId !== null && a.masterId === b.masterId;

            if (expectedSame && actualSame) {
                tp += 1;
            } else if (!expectedSame && actualSame) {
                fp += 1;
                misclassifications.push({
                    a: a.fixture,
                    b: b.fixture,
                    expectedSame,
                    actualSame,
                    aMaster: a.masterId,
                    bMaster: b.masterId,
                });
            } else if (expectedSame && !actualSame) {
                fn += 1;
                misclassifications.push({
                    a: a.fixture,
                    b: b.fixture,
                    expectedSame,
                    actualSame,
                    aMaster: a.masterId,
                    bMaster: b.masterId,
                });
            } else {
                tn += 1;
            }
        }
    }

    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

    return {
        totalPairs: tp + fp + fn + tn,
        truePositive: tp,
        falsePositive: fp,
        falseNegative: fn,
        trueNegative: tn,
        precision,
        recall,
        f1,
        misclassifications,
    };
}

export function formatSummary(s: GoldenSummary): string {
    const lines: string[] = [
        `total pairs: ${s.totalPairs}`,
        `TP=${s.truePositive} FP=${s.falsePositive} FN=${s.falseNegative} TN=${s.trueNegative}`,
        `precision=${s.precision.toFixed(4)} recall=${s.recall.toFixed(4)} F1=${s.f1.toFixed(4)}`,
    ];
    if (s.misclassifications.length > 0) {
        lines.push("", "misclassifications:");
        for (const m of s.misclassifications) {
            const label = m.expectedSame ? "FN" : "FP";
            lines.push(
                `  [${label}] expected ${m.expectedSame ? "same" : "different"}, got ${m.actualSame ? "same" : "different"}`
            );
            lines.push(
                `        A: ${m.a.shop_origin} | ${m.a.name} | brand=${m.a.brand} ean=${m.a.ean} master=${m.aMaster}`
            );
            lines.push(
                `        B: ${m.b.shop_origin} | ${m.b.name} | brand=${m.b.brand} ean=${m.b.ean} master=${m.bMaster}`
            );
        }
    }

    return lines.join("\n");
}
