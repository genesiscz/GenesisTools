import { homedir } from "node:os";
import { join } from "node:path";
import type { Database as BunDatabase } from "bun:sqlite";
import logger from "@app/logger";
import { type DatabaseClient, createKyselyClient } from "@app/utils/database/client";
import type { Insertable, Kysely } from "kysely";
import { SHOPS_MIGRATIONS } from "./migrations";
import type {
    CurrentOffersView,
    NewHttpRequest,
    NewMasterProduct,
    NewPrice,
    NewProduct,
    ShopsDB,
    ShopsTable,
} from "./types";

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
        return await this.client.kysely
            .selectFrom("shops")
            .selectAll()
            .where("origin", "=", origin)
            .executeTakeFirst();
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

    async upsertProduct(
        input: Omit<NewProduct, "match_at" | "first_seen_at" | "last_updated_at">
    ): Promise<number> {
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
