import { HlidacShopuClient } from "../api/HlidacShopuClient";
import { getShopsDatabase, type ShopsDatabase } from "../db/ShopsDatabase";
import { getDefaultSink, type HttpRequestSink } from "./http-sink";
import { type IngestResult, ingestFromHlidacResult } from "./ingest";

export interface RunGetProductOptions {
    url: string;
    db?: ShopsDatabase;
    sink?: HttpRequestSink;
    client?: HlidacShopuClient;
}

export interface RunGetProductResult {
    ingested: IngestResult;
    source: string;
}

export async function runGetProduct(opts: RunGetProductOptions): Promise<RunGetProductResult> {
    const db = opts.db ?? getShopsDatabase();
    const sink = opts.sink ?? getDefaultSink();
    const client = opts.client ?? new HlidacShopuClient({ sink });

    const data = await client.getByUrl(opts.url);
    const ingested = await ingestFromHlidacResult({ db, url: opts.url, data });
    return { ingested, source: data.source };
}
