import { HlidacShopuClient } from "@app/shops/api/HlidacShopuClient";
import type { HlidacGetByUrlResult } from "@app/shops/api/HlidacShopuClient.types";
import { initShopRegistry } from "@app/shops/api/registry-init";
import type { RawProduct } from "@app/shops/api/ShopApiClient.types";
import { ShopRegistry } from "@app/shops/api/ShopRegistry";
import { getShopsDatabase, type ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { getDefaultSink, type HttpRequestSink } from "@app/shops/lib/http-sink";
import { type IngestResult, ingestFromHlidacResult } from "@app/shops/lib/ingest";

export type ResolveFromShopClient = (origin: string, url: string) => Promise<RawProduct | null>;

export interface RunGetProductOptions {
    url: string;
    db?: ShopsDatabase;
    sink?: HttpRequestSink;
    client?: HlidacShopuClient;
    resolveFromShopClient?: ResolveFromShopClient;
}

export interface RunGetProductResult {
    ingested: IngestResult;
    source: string;
}

export async function runGetProduct(opts: RunGetProductOptions): Promise<RunGetProductResult> {
    const db = opts.db ?? getShopsDatabase();
    const sink = opts.sink ?? getDefaultSink();
    const client = opts.client ?? new HlidacShopuClient({ sink });
    const resolveFromShopClient = opts.resolveFromShopClient ?? defaultResolveFromShopClient(sink);

    let data = await client.getByUrl(opts.url);
    if (shouldEnrichFromShopClient(data) && data.parsed.origin) {
        const raw = await resolveFromShopClient(data.parsed.origin, opts.url);
        if (raw) {
            data = mergeWithRawProduct(data, raw);
        }
    }

    const ingested = await ingestFromHlidacResult({ db, url: opts.url, data });
    return { ingested, source: data.source };
}

/**
 * Trigger ShopClient enrichment when Hlídač's payload is missing data the
 * matcher relies on for cross-shop linking. Hlídač's S3 metadata never
 * carries `brand` or `ean` — without these, two records of the same product
 * across shops auto-seed as separate masters because fuzzy-name + empty
 * brand falls below the link threshold. ShopClients (per-shop API/scrape)
 * already harvest brand+ean for their own crawler path, so we reuse that.
 *
 * Also fires when name is missing (the original GET-FALLBACK case so
 * `tools shops get` doesn't bottom out on a URL-derived placeholder).
 */
function shouldEnrichFromShopClient(data: HlidacGetByUrlResult): boolean {
    const hasName = Boolean(data.meta?.itemName ?? data.detail?.metadata.name);
    if (!hasName) {
        return true;
    }

    const brand = data.enrichment?.brand;
    const ean = data.enrichment?.ean;
    return !brand || !ean;
}

function mergeWithRawProduct(data: HlidacGetByUrlResult, raw: RawProduct): HlidacGetByUrlResult {
    const observedDay = raw.observedAt.toISOString().slice(0, 10);
    const synthesizedHistory =
        raw.currentPrice !== undefined
            ? {
                  commonPrice: raw.originalPrice ?? null,
                  minPrice: null,
                  entries: [{ d: observedDay, c: raw.currentPrice, o: raw.originalPrice ?? null }],
              }
            : null;

    const hadHlidacName = Boolean(data.meta?.itemName ?? data.detail?.metadata.name);
    return {
        ...data,
        // Preserve "s3" source when Hlídač already had history; the ShopClient
        // call only enriched metadata, the price history is still S3-sourced.
        source: hadHlidacName ? data.source : "scrape",
        parsed: {
            ...data.parsed,
            itemId: data.parsed.itemId ?? raw.itemId ?? raw.slug,
        },
        meta: {
            itemId: data.meta?.itemId ?? raw.itemId ?? raw.slug ?? data.parsed.itemId ?? "",
            itemName: data.meta?.itemName ?? raw.name,
            itemImage: data.meta?.itemImage ?? raw.imageUrl,
        },
        history: data.history ?? synthesizedHistory,
        enrichment: {
            ...data.enrichment,
            brand: data.enrichment?.brand ?? raw.brand,
            ean: data.enrichment?.ean ?? raw.ean,
            unit: data.enrichment?.unit ?? coerceUnit(raw.unit),
            unitAmount: data.enrichment?.unitAmount ?? raw.unitAmount,
            categoryPath: data.enrichment?.categoryPath ?? raw.categoryPath,
        },
    };
}

const RAW_UNITS = new Set(["g", "kg", "ml", "l", "ks", "m", "m2"]);

function coerceUnit(raw: string | undefined): "g" | "kg" | "ml" | "l" | "ks" | "m" | "m2" | undefined {
    if (raw === undefined) {
        return undefined;
    }

    const normalized = raw.toLowerCase().trim();
    if (RAW_UNITS.has(normalized)) {
        return normalized as "g" | "kg" | "ml" | "l" | "ks" | "m" | "m2";
    }

    return undefined;
}

function defaultResolveFromShopClient(sink: HttpRequestSink): ResolveFromShopClient {
    return async (origin, url) => {
        initShopRegistry({ sink });
        const client = ShopRegistry.get().forShop(origin);
        if (!client) {
            return null;
        }

        try {
            return await client.getProduct({ url });
        } catch {
            return null;
        }
    };
}
