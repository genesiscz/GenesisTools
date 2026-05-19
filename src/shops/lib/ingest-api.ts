import { logger } from "@app/logger";
import { HlidacShopuClient } from "@app/shops/api/HlidacShopuClient";
import type { HlidacGetByUrlResult } from "@app/shops/api/HlidacShopuClient.types";
import { getShopsDatabase, type ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { ingestFromHlidacResult } from "@app/shops/lib/ingest";
// @ts-expect-error -- @hlidac-shopu/lib ships ESM with no .d.ts coverage
import { shopOrigin as deriveShopOrigin } from "@hlidac-shopu/lib/shops.mjs";

const log = logger.child({ component: "shops:ingest-api" });

interface HlidacFetcher {
    getByUrl(url: string): Promise<HlidacGetByUrlResult>;
}

export interface IngestApiContext {
    shopsDb?: ShopsDatabase;
    hlidac?: HlidacFetcher;
}

export interface IngestUrlInput {
    url: string;
}

export interface IngestUrlResult {
    product_id: number;
    master_product_id: number | null;
    shop_origin: string;
    slug: string;
    prices_recorded: number;
    source: "s3" | "api" | "scrape";
    auto_seeded_master: boolean;
}

export async function ingestUrl(input: IngestUrlInput, ctx?: IngestApiContext): Promise<IngestUrlResult> {
    const shopsDb = ctx?.shopsDb ?? getShopsDatabase();
    const hlidac: HlidacFetcher = ctx?.hlidac ?? new HlidacShopuClient();

    const origin = deriveShopOrigin(input.url);
    if (!origin) {
        throw new Error(`Cannot derive shop origin from url: ${input.url}`);
    }

    const existing = await shopsDb
        .kysely()
        .selectFrom("products")
        .select(["id", "master_product_id"])
        .where("url", "=", input.url)
        .executeTakeFirst();

    const data = await hlidac.getByUrl(input.url);
    const result = await ingestFromHlidacResult({ db: shopsDb, url: input.url, data });

    log.info(
        {
            url: input.url,
            shopOrigin: result.product.shop_origin,
            slug: result.product.slug,
            pricesRecorded: result.pricesRecorded,
            source: data.source,
            autoSeeded: !existing,
        },
        "ingestUrl done"
    );

    return {
        product_id: result.product.id,
        master_product_id: result.product.master_product_id,
        shop_origin: result.product.shop_origin,
        slug: result.product.slug,
        prices_recorded: result.pricesRecorded,
        source: data.source,
        auto_seeded_master: !existing,
    };
}
