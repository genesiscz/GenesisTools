import { HlidacShopuClient } from "../api/HlidacShopuClient";
import type { HlidacGetByUrlResult } from "../api/HlidacShopuClient.types";
import { initShopRegistry } from "../api/registry-init";
import { ShopRegistry } from "../api/ShopRegistry";
import type { RawProduct } from "../api/ShopApiClient.types";
import { getShopsDatabase, type ShopsDatabase } from "../db/ShopsDatabase";
import { getDefaultSink, type HttpRequestSink } from "./http-sink";
import { type IngestResult, ingestFromHlidacResult } from "./ingest";

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
    if (shouldFallbackToShopClient(data) && data.parsed.origin) {
        const raw = await resolveFromShopClient(data.parsed.origin, opts.url);
        if (raw) {
            data = mergeWithRawProduct(data, raw);
        }
    }

    const ingested = await ingestFromHlidacResult({ db, url: opts.url, data });
    return { ingested, source: data.source };
}

/**
 * Hlídač gave us nothing usable — no S3 history, no /v2/detail, no meta —
 * so the master would otherwise be auto-seeded with a URL-pathname-derived
 * name. Better: ask the shop's own client to scrape the product page (it
 * already mirrors the topmonks/hlidac-shopu actor for that shop).
 */
function shouldFallbackToShopClient(data: HlidacGetByUrlResult): boolean {
    const hasName = Boolean(data.meta?.itemName ?? data.detail?.metadata.name);
    return !hasName;
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

    return {
        ...data,
        source: "scrape",
        parsed: {
            ...data.parsed,
            itemId: raw.itemId ?? raw.slug ?? data.parsed.itemId,
        },
        meta: {
            itemId: raw.itemId ?? raw.slug ?? data.parsed.itemId ?? "",
            itemName: raw.name,
            itemImage: raw.imageUrl,
        },
        history: data.history ?? synthesizedHistory,
    };
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
