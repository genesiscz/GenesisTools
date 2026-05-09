import logger from "@app/logger";
import { removeDiacritics } from "@app/utils/string";
import type { HlidacGetByUrlResult } from "../api/HlidacShopuClient.types";
import type { ShopsDatabase } from "../db/ShopsDatabase";
import type { Product } from "../db/types";

export interface IngestArgs {
    db: ShopsDatabase;
    url: string;
    data: HlidacGetByUrlResult;
}

export interface IngestResult {
    product: Product;
    pricesRecorded: number;
    autoSeededMaster: boolean;
}

const log = logger.child({ component: "shops:ingest" });

export async function ingestFromHlidacResult(args: IngestArgs): Promise<IngestResult> {
    const { db, url, data } = args;

    if (!data.parsed.origin) {
        throw new Error(`Cannot ingest URL ${url}: shop origin is unknown.`);
    }

    const existingShop = await db.getShopByOrigin(data.parsed.origin);
    if (!existingShop) {
        await db.upsertShop({
            origin: data.parsed.origin,
            display_name: data.parsed.origin,
            currency: "CZK",
            cap_live: 0,
            cap_history: 1,
            cap_listing: 0,
            cap_ean: 0,
            cap_search: 0,
            bot_protection: "none",
        });
    }

    // Hlídač's lib doesn't provide itemId/itemUrl for some shops (dm.cz, mojadm.sk,
    // hornbach.cz post-URL-redesign). Derive a stable slug from the URL pathname so
    // the product gets a unique (shop_origin, slug) row instead of crashing.
    const slug = data.parsed.itemId ?? data.parsed.itemUrl ?? deriveSlugFromUrl(url);
    const name = data.meta?.itemName ?? data.detail?.metadata.name ?? slug;
    const imageUrl = data.meta?.itemImage ?? data.detail?.metadata.imageUrl ?? null;

    const canonicalSlug = computeCanonicalSlug(name, data.parsed.origin, slug);
    const masterId = await db.upsertMasterProduct({
        canonical_name: name,
        canonical_name_normalized: normalizeText(name),
        canonical_slug: canonicalSlug,
        brand: null,
        brand_normalized: null,
        ean: null,
        unit: null,
        unit_amount: null,
        pack_count: null,
        flavor_key: null,
        representative_image_url: imageUrl,
        attributes_json: "{}",
        verified_by: "auto",
    });

    const productId = await db.upsertProduct({
        shop_origin: data.parsed.origin,
        slug,
        url,
        name,
        name_normalized: normalizeText(name),
        brand: null,
        brand_normalized: null,
        ean: null,
        image_url: imageUrl,
        unit: null,
        unit_amount: null,
        pack_count: null,
        flavor_key: null,
        master_product_id: masterId,
        match_method: "auto-seed",
        match_similarity: null,
    });

    const priceRows = (data.history?.entries ?? [])
        .filter((e) => e.c !== null)
        .map((e) => ({
            product_id: productId,
            observed_at: `${e.d}T00:00:00Z`,
            current_price: e.c,
            original_price: e.o,
            in_stock: null,
            source: data.source === "s3" ? "hlidac-s3" : "hlidac-detail",
            raw_json: null,
        }));
    const recorded = priceRows.length > 0 ? await db.recordPrices(priceRows) : 0;

    log.debug(
        { url, productId, masterId, pricesRecorded: recorded, source: data.source },
        "ingestFromHlidacResult done"
    );

    const product = (await db
        .kysely()
        .selectFrom("products")
        .selectAll()
        .where("id", "=", productId)
        .executeTakeFirstOrThrow()) as Product;

    return { product, pricesRecorded: recorded, autoSeededMaster: true };
}

function normalizeText(s: string): string {
    return removeDiacritics(s).toLowerCase().replace(/\s+/g, " ").trim();
}

function deriveSlugFromUrl(url: string): string {
    try {
        const path = new URL(url).pathname.replace(/^\/+|\/+$/g, "");
        return path || url;
    } catch {
        return url;
    }
}

function computeCanonicalSlug(name: string, origin: string, slug: string): string {
    const norm = normalizeText(name)
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    const safeOrigin = origin.replace(/\./g, "-");
    const safeSlug = slug.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
    return `${safeOrigin}--${safeSlug}--${norm}`.slice(0, 240);
}
