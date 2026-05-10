import type { Database as BunDatabase } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import logger from "@app/logger";
import type { RawProduct } from "@app/shops/api/ShopApiClient.types";
import { SHOPS_MIGRATIONS } from "@app/shops/db/migrations";
import type {
    CurrentOffersView,
    NewHttpRequest,
    NewMasterProduct,
    NewPrice,
    NewProduct,
    ShopsDB,
    ShopsTable,
} from "@app/shops/db/types";
import {
    extractFlavorKey,
    extractPackCount,
    extractSize,
    normalizeText,
    parseUnit,
    type Unit,
} from "@app/shops/lib/normalize";
import { createKyselyClient, type DatabaseClient } from "@app/utils/database/client";
import { SafeJSON } from "@app/utils/json";
import type { Insertable, Kysely } from "kysely";

export interface StartCrawlRunInput {
    shopOrigin: string;
    strategy: string;
    options: {
        categoryId?: string;
        limit?: number;
        since?: string;
    } & Record<string, unknown>;
}

export interface CrawlCounterDelta {
    productsSeen?: number;
    productsNew?: number;
    pricesRecorded?: number;
    candidatesAdded?: number;
}

export type CrawlRunStatus = "running" | "matching" | "completed" | "failed" | "cancelled";

export interface UpsertProductPendingResult {
    id: number;
    isNew: boolean;
}

export interface ListProductsInput {
    shopOrigin: string;
    categoryId?: string;
    limit: number;
    offset?: number;
    search?: string;
}

export interface ListedProduct {
    id: number;
    name: string;
    brand?: string;
    currentPrice?: number;
    url: string;
    imageUrl?: string;
}

const DEFAULT_DB_PATH = join(homedir(), ".genesis-tools", "shops", "index.db");

export class ShopsDatabase {
    private readonly client: DatabaseClient<ShopsDB>;
    private readonly log = logger.child({ component: "ShopsDatabase" });

    constructor(dbPath: string = DEFAULT_DB_PATH) {
        this.client = createKyselyClient<ShopsDB>({
            path: dbPath,
            migrations: SHOPS_MIGRATIONS,
            migrationContext: { tableName: "shops" },
            pragmas: { journalMode: "WAL", busyTimeoutMs: 5000, foreignKeys: true },
        });
        this.log.debug({ path: dbPath }, "shops database opened");
    }

    kysely(): Kysely<ShopsDB> {
        return this.client.kysely;
    }

    raw(): BunDatabase {
        return this.client.raw;
    }

    path(): string {
        return this.client.path;
    }

    close(): void {
        this.client.close();
    }

    async upsertShop(row: Insertable<ShopsTable>): Promise<void> {
        await this.client.kysely
            .insertInto("shops")
            .values(row)
            .onConflict((oc) =>
                oc.column("origin").doUpdateSet({
                    display_name: row.display_name,
                    currency: row.currency,
                    cap_live: row.cap_live,
                    cap_history: row.cap_history,
                    cap_listing: row.cap_listing,
                    cap_ean: row.cap_ean,
                    cap_search: row.cap_search,
                    bot_protection: row.bot_protection,
                })
            )
            .execute();
    }

    async getShopByOrigin(origin: string) {
        return await this.client.kysely.selectFrom("shops").selectAll().where("origin", "=", origin).executeTakeFirst();
    }

    async upsertMasterProduct(input: NewMasterProduct): Promise<number> {
        const now = new Date().toISOString();
        const row = await this.client.kysely
            .insertInto("master_products")
            .values({
                ...input,
                created_at: input.created_at ?? now,
                updated_at: input.updated_at ?? now,
            })
            .onConflict((oc) =>
                oc.column("canonical_slug").doUpdateSet({
                    canonical_name: input.canonical_name,
                    updated_at: now,
                })
            )
            .returning("id")
            .executeTakeFirstOrThrow();
        return row.id;
    }

    async getMasterProductById(id: number) {
        return await this.client.kysely
            .selectFrom("master_products")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst();
    }

    async upsertProduct(input: Omit<NewProduct, "match_at" | "first_seen_at" | "last_updated_at">): Promise<number> {
        const now = new Date().toISOString();
        const values: NewProduct = {
            ...input,
            match_at: now,
            first_seen_at: now,
            last_updated_at: now,
        };

        const row = await this.client.kysely
            .insertInto("products")
            .values(values)
            .onConflict((oc) =>
                oc.columns(["shop_origin", "slug"]).doUpdateSet({
                    url: input.url,
                    name: input.name,
                    name_normalized: input.name_normalized,
                    brand: input.brand ?? null,
                    brand_normalized: input.brand_normalized ?? null,
                    ean: input.ean ?? null,
                    image_url: input.image_url ?? null,
                    unit: input.unit ?? null,
                    unit_amount: input.unit_amount ?? null,
                    pack_count: input.pack_count ?? null,
                    flavor_key: input.flavor_key ?? null,
                    last_updated_at: now,
                    is_active: 1,
                })
            )
            .returning("id")
            .executeTakeFirstOrThrow();
        return row.id;
    }

    async getProductByShopAndSlug(shopOrigin: string, slug: string) {
        return await this.client.kysely
            .selectFrom("products")
            .selectAll()
            .where("shop_origin", "=", shopOrigin)
            .where("slug", "=", slug)
            .executeTakeFirst();
    }

    async recordPrice(input: NewPrice): Promise<void> {
        await this.client.kysely
            .insertInto("prices")
            .values(input)
            .onConflict((oc) =>
                oc.columns(["product_id", "observed_at"]).doUpdateSet({
                    current_price: input.current_price ?? null,
                    original_price: input.original_price ?? null,
                    in_stock: input.in_stock ?? null,
                    source: input.source,
                })
            )
            .execute();
    }

    async recordPrices(rows: NewPrice[]): Promise<number> {
        if (rows.length === 0) {
            return 0;
        }

        await this.client.kysely
            .insertInto("prices")
            .values(rows)
            .onConflict((oc) =>
                oc.columns(["product_id", "observed_at"]).doUpdateSet((eb) => ({
                    current_price: eb.ref("excluded.current_price"),
                    original_price: eb.ref("excluded.original_price"),
                    in_stock: eb.ref("excluded.in_stock"),
                    source: eb.ref("excluded.source"),
                }))
            )
            .execute();
        return rows.length;
    }

    async getCurrentOffersForMaster(masterProductId: number): Promise<CurrentOffersView[]> {
        return await this.client.kysely
            .selectFrom("current_offers")
            .selectAll()
            .where("master_product_id", "=", masterProductId)
            .execute();
    }

    async insertHttpRequest(row: NewHttpRequest): Promise<void> {
        await this.client.kysely.insertInto("http_requests").values(row).execute();
    }

    /**
     * Bulk-crawl variant of upsertProduct. Writes the product with
     * `master_product_id = NULL` and `match_method = 'pending'` so Plan 04's
     * BulkMatcher can resolve master assignment after the crawl finishes in
     * a single transaction. Auto-seed semantics live in `lib/ingest.ts` and
     * are reserved for the single-product `tools shops get` path.
     */
    async upsertProductPending(raw: RawProduct): Promise<UpsertProductPendingResult> {
        const now = new Date().toISOString();
        await this.ensureShopRegistered(raw.shopOrigin);

        const existing = await this.client.kysely
            .selectFrom("products")
            .select(["id"])
            .where("shop_origin", "=", raw.shopOrigin)
            .where("slug", "=", raw.slug)
            .executeTakeFirst();

        const categoryPath = raw.categoryPath && raw.categoryPath.length > 0 ? raw.categoryPath.join(" > ") : null;
        const metadataJson = SafeJSON.stringify(raw.raw ?? {});

        // Derive unit/unitAmount/packCount/flavor from the product name when
        // the shop client doesn't supply them directly. Without these the
        // matcher's Layer 1 (brand+unit+amount+flavor) and Layer 2a
        // (brand+unit+amount) bail at the null-check, so cross-shop matching
        // collapses to fuzzy-only — see Verification2.handoff "matcher unit
        // gap" entry for the impact analysis.
        // Treat (unit, unitAmount) as a coupled tuple — never let an
        // unrecognised raw.unit (e.g. Rohlik's "33 praní" pseudo-unit)
        // strand the amount on top of a different source. Either both
        // come from the shop's parsed payload, or both fall back to
        // name extraction.
        const sizeFromName = extractSize(raw.name);
        const rawUnit = raw.unit ? parseUnit(raw.unit) : null;
        const rawSize = rawUnit ? { unit: rawUnit, unitAmount: raw.unitAmount } : null;
        const size = rawSize ?? sizeFromName ?? null;
        const unit: Unit | null = size?.unit ?? null;
        const unitAmount = size?.unitAmount ?? null;
        const packCount = extractPackCount(raw.name);
        const flavorKey = extractFlavorKey(raw.name);

        const values: NewProduct = {
            shop_origin: raw.shopOrigin,
            slug: raw.slug,
            url: raw.url,
            name: raw.name,
            name_normalized: normalizeText(raw.name),
            brand: raw.brand ?? null,
            brand_normalized: raw.brand ? normalizeText(raw.brand) : null,
            ean: raw.ean ?? null,
            image_url: raw.imageUrl ?? null,
            unit,
            unit_amount: unitAmount,
            pack_count: packCount,
            flavor_key: flavorKey,
            master_product_id: null,
            match_method: "pending",
            match_similarity: null,
            match_at: now,
            first_seen_at: now,
            last_updated_at: now,
            description: raw.description ?? null,
            category_path: categoryPath,
            metadata_json: metadataJson,
        };

        const row = await this.client.kysely
            .insertInto("products")
            .values(values)
            .onConflict((oc) =>
                oc.columns(["shop_origin", "slug"]).doUpdateSet({
                    url: values.url,
                    name: values.name,
                    name_normalized: values.name_normalized,
                    brand: values.brand,
                    brand_normalized: values.brand_normalized,
                    ean: values.ean,
                    image_url: values.image_url,
                    unit: values.unit,
                    unit_amount: values.unit_amount,
                    pack_count: values.pack_count,
                    flavor_key: values.flavor_key,
                    last_updated_at: now,
                    is_active: 1,
                    description: values.description,
                    category_path: values.category_path,
                    metadata_json: values.metadata_json,
                })
            )
            .returning("id")
            .executeTakeFirstOrThrow();

        return { id: row.id, isNew: !existing };
    }

    private async ensureShopRegistered(origin: string): Promise<void> {
        const existing = await this.getShopByOrigin(origin);
        if (existing) {
            return;
        }

        await this.upsertShop({
            origin,
            display_name: origin,
            currency: "CZK",
            cap_live: 1,
            cap_history: 1,
            cap_listing: 1,
            cap_ean: 0,
            cap_search: 0,
            bot_protection: "none",
        });
    }

    async startCrawlRun(input: StartCrawlRunInput): Promise<number> {
        await this.ensureShopRegistered(input.shopOrigin);
        const now = new Date().toISOString();
        const row = await this.client.kysely
            .insertInto("crawl_runs")
            .values({
                shop_origin: input.shopOrigin,
                strategy: input.strategy,
                started_at: now,
                option_category_id: input.options.categoryId ?? null,
                option_limit: input.options.limit ?? null,
                option_since: input.options.since ?? null,
                options_json: SafeJSON.stringify(input.options),
            })
            .returning("id")
            .executeTakeFirstOrThrow();
        return row.id;
    }

    async incrementCrawlCounters(crawlRunId: number, delta: CrawlCounterDelta): Promise<void> {
        const sets: string[] = [];
        const params: number[] = [];
        if (delta.productsSeen) {
            sets.push("products_seen = products_seen + ?");
            params.push(delta.productsSeen);
        }

        if (delta.productsNew) {
            sets.push("products_new = products_new + ?");
            params.push(delta.productsNew);
        }

        if (delta.pricesRecorded) {
            sets.push("prices_recorded = prices_recorded + ?");
            params.push(delta.pricesRecorded);
        }

        if (delta.candidatesAdded) {
            sets.push("candidates_added = candidates_added + ?");
            params.push(delta.candidatesAdded);
        }

        if (sets.length === 0) {
            return;
        }

        const sql = `UPDATE crawl_runs SET ${sets.join(", ")} WHERE id = ?`;
        params.push(crawlRunId);
        this.client.raw.prepare(sql).run(...params);
    }

    async finishCrawlRun(crawlRunId: number, status: CrawlRunStatus, error?: string): Promise<void> {
        await this.client.kysely
            .updateTable("crawl_runs")
            .set({
                status,
                finished_at: new Date().toISOString(),
                error: error ?? null,
            })
            .where("id", "=", crawlRunId)
            .execute();
    }

    async listProducts(input: ListProductsInput): Promise<ListedProduct[]> {
        const limit = input.limit;
        const offset = input.offset ?? 0;

        if (input.search && input.search.trim().length > 0) {
            return this.searchProducts(input.shopOrigin, input.search.trim(), limit, offset);
        }

        let query = this.client.kysely
            .selectFrom("current_offers")
            .innerJoin("products", "products.id", "current_offers.product_id")
            .select([
                "current_offers.product_id as id",
                "current_offers.name",
                "products.brand",
                "current_offers.current_price as currentPrice",
                "current_offers.url",
                "current_offers.image_url as imageUrl",
            ])
            .where("current_offers.shop_origin", "=", input.shopOrigin)
            .orderBy("current_offers.product_id");

        if (input.categoryId) {
            query = query
                .innerJoin("product_categories", "product_categories.product_id", "current_offers.product_id")
                .where("product_categories.category_id", "=", input.categoryId)
                .where("product_categories.shop_origin", "=", input.shopOrigin);
        }

        const rows = await query.limit(limit).offset(offset).execute();
        return rows.map((r) => ({
            id: r.id,
            name: r.name,
            brand: r.brand ?? undefined,
            currentPrice: r.currentPrice ?? undefined,
            url: r.url,
            imageUrl: r.imageUrl ?? undefined,
        }));
    }

    private async searchProducts(
        shopOrigin: string,
        searchText: string,
        limit: number,
        offset: number
    ): Promise<ListedProduct[]> {
        const ftsQuery = `${normalizeText(searchText)}*`;
        const sql = `
            SELECT
                p.id              AS id,
                p.name            AS name,
                p.brand           AS brand,
                co.current_price  AS current_price,
                p.url             AS url,
                p.image_url       AS image_url
            FROM products_fts
            JOIN products p ON p.id = products_fts.rowid
            LEFT JOIN current_offers co ON co.product_id = p.id
            WHERE products_fts MATCH ?
              AND p.shop_origin = ?
              AND p.is_active = 1
            ORDER BY rank
            LIMIT ? OFFSET ?`;
        const rows = this.client.raw.prepare(sql).all(ftsQuery, shopOrigin, limit, offset) as Array<{
            id: number;
            name: string;
            brand: string | null;
            current_price: number | null;
            url: string;
            image_url: string | null;
        }>;

        return rows.map((r) => ({
            id: r.id,
            name: r.name,
            brand: r.brand ?? undefined,
            currentPrice: r.current_price ?? undefined,
            url: r.url,
            imageUrl: r.image_url ?? undefined,
        }));
    }
}

let singleton: ShopsDatabase | null = null;

export function getShopsDatabase(): ShopsDatabase {
    if (!singleton) {
        singleton = new ShopsDatabase();
    }

    return singleton;
}

export function resetShopsDatabaseSingleton(): void {
    singleton?.close();
    singleton = null;
}

export function setShopsDatabaseSingletonForTest(db: ShopsDatabase | null): void {
    singleton = db;
}
