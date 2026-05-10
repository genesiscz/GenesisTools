import logger from "@app/logger";
import type { HlidacGetByUrlResult } from "@app/shops/api/HlidacShopuClient.types";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { Product } from "@app/shops/db/types";
import { createMatchExecutor } from "@app/shops/lib/bulk-matcher";
import { refreshMasterDenorm } from "@app/shops/lib/master-denorm";
import { removeDiacritics } from "@app/utils/string";

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

    // Reuse existing product+master when the URL is already known. Crawlers often
    // ingest a product before `tools shops get` runs against the same URL — without
    // this lookup we'd seed a *second* master with Hlídač's (often empty) metadata,
    // producing the duplicate-master + slug-as-name UI bugs (see Verification.handoff
    // UI-1, UI-2).
    const existingProduct = await db.getProductByShopAndSlug(data.parsed.origin, slug);

    const hlidacName = data.meta?.itemName ?? data.detail?.metadata.name;
    const name = hlidacName ?? existingProduct?.name ?? deriveNameFromUrl(url, slug);
    const imageUrl = data.meta?.itemImage ?? data.detail?.metadata.imageUrl ?? existingProduct?.image_url ?? null;

    const enrichment = data.enrichment;
    const brand = enrichment?.brand ?? existingProduct?.brand ?? null;
    const ean = enrichment?.ean ?? existingProduct?.ean ?? null;
    const unit = enrichment?.unit ?? existingProduct?.unit ?? null;
    const unitAmount = enrichment?.unitAmount ?? existingProduct?.unit_amount ?? null;
    const packCount = enrichment?.packCount ?? existingProduct?.pack_count ?? null;
    const brandNormalized = brand !== null ? normalizeText(brand) : null;

    // Insert the product as 'pending' first; the matcher decides whether to
    // link to an existing master (EAN, signature, fuzzy-brand-name) or seed
    // a new one. Previously this path always auto-seeded, which created
    // separate masters for the same product across shops whenever Hlídač's
    // metadata was thin (no EAN, no brand) — even if the per-shop ShopClient
    // could have provided that metadata via `enrichment`.
    const productId = await db.upsertProduct({
        shop_origin: data.parsed.origin,
        slug,
        url,
        name,
        name_normalized: normalizeText(name),
        brand,
        brand_normalized: brandNormalized,
        ean,
        image_url: imageUrl,
        unit,
        unit_amount: unitAmount,
        pack_count: packCount,
        flavor_key: null,
        master_product_id: existingProduct?.master_product_id ?? null,
        match_method: existingProduct?.master_product_id ? (existingProduct.match_method ?? "auto-seed") : "pending",
        match_similarity: null,
    });

    let masterId = existingProduct?.master_product_id ?? null;
    if (!masterId) {
        const result = await createMatchExecutor(db).apply({
            productId,
            shopOrigin: data.parsed.origin,
            name,
            nameNormalized: normalizeText(name),
            brandRaw: brand,
            brandNormalized,
            ean,
            unit,
            unitAmount,
            packCount,
            flavorKey: null,
        });
        if (result.kind === "linked" || result.kind === "seed") {
            const row = db
                .raw()
                .query<{ master_product_id: number | null }, [number]>(
                    "SELECT master_product_id FROM products WHERE id = ?"
                )
                .get(productId);
            masterId = row?.master_product_id ?? null;
        }
    }

    const priceRows = (data.history?.entries ?? [])
        .filter((e) => e.c !== null)
        .map((e) => ({
            product_id: productId,
            observed_at: `${e.d}T00:00:00Z`,
            current_price: e.c,
            original_price: e.o,
            in_stock: null,
            source: priceSourceLabel(data.source),
            raw_json: null,
        }));
    const recorded = priceRows.length > 0 ? await db.recordPrices(priceRows) : 0;

    if (masterId !== null) {
        await refreshMasterDenorm(db, masterId);
    }

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

function priceSourceLabel(source: HlidacGetByUrlResult["source"]): string {
    if (source === "s3") {
        return "hlidac-s3";
    }

    if (source === "scrape") {
        return "shop-scrape";
    }

    return "hlidac-detail";
}

function deriveSlugFromUrl(url: string): string {
    try {
        const path = new URL(url).pathname.replace(/^\/+|\/+$/g, "");
        return path || url;
    } catch {
        return url;
    }
}

/**
 * Last-resort name derivation when neither Hlídač metadata nor a previously-crawled
 * product row gives us a real name. Strips numeric ID prefixes and dashes from the
 * URL's last path segment so `1419780-ritter-sport-mlecna-cokolada` becomes
 * `Ritter sport mlecna cokolada` rather than auto-seeding a master named `1419780`.
 */
function deriveNameFromUrl(url: string, slugFallback: string): string {
    let segment: string;
    try {
        const path = new URL(url).pathname.replace(/^\/+|\/+$/g, "");
        segment = path.split("/").pop() ?? slugFallback;
    } catch {
        return slugFallback;
    }

    segment = segment.replace(/\.html?$/i, "");

    // Strip a leading numeric id ("1419780-ritter-sport...") or "p<id>-" prefix.
    const stripped = segment.replace(/^p?\d+[-_]/, "");

    if (stripped.length === 0 || /^\d+$/.test(stripped)) {
        return slugFallback;
    }

    const humanized = stripped.replace(/[-_]+/g, " ").trim();
    if (humanized.length === 0) {
        return slugFallback;
    }

    return humanized.charAt(0).toUpperCase() + humanized.slice(1);
}
