import logger from "@app/logger";
import { getShopsDatabase, type ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { SafeJSON } from "@app/utils/json";

const RESPONSE_EXCERPT_MAX = 2048;
const REQUEST_EXCERPT_MAX = 1024;

export interface HttpRequestEvent {
    ts: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
    url: string;
    shopOrigin: string | null;
    source: string;
    operation?: string;
    status?: number;
    durationMs: number;
    requestId: string;
    requestBytes?: number;
    responseBytes?: number;
    requestExcerpt: string | null;
    responseExcerpt: string | null;
    error: string | null;
    crawlRunId?: number | null;
    productSlug?: string | null;
    masterProductId?: number | null;
    categoryId?: string | null;
    context: Record<string, unknown>;
}

export interface HttpRequestSink {
    record(event: HttpRequestEvent): Promise<void>;
}

const sinkLogger = logger.child({ component: "DbHttpRequestSink" });

export class DbHttpRequestSink implements HttpRequestSink {
    constructor(private readonly db: ShopsDatabase) {}

    async record(event: HttpRequestEvent): Promise<void> {
        try {
            await this.db.insertHttpRequest({
                ts: event.ts,
                method: event.method,
                url: event.url,
                shop_origin: event.shopOrigin,
                source: event.source,
                operation: event.operation ?? null,
                status: event.status ?? null,
                duration_ms: event.durationMs,
                request_bytes: event.requestBytes ?? null,
                response_bytes: event.responseBytes ?? null,
                request_id: event.requestId,
                crawl_run_id: event.crawlRunId ?? null,
                product_slug: event.productSlug ?? null,
                master_product_id: event.masterProductId ?? null,
                category_id: event.categoryId ?? null,
                error: event.error,
                request_excerpt: truncate(event.requestExcerpt, REQUEST_EXCERPT_MAX),
                response_excerpt: truncate(event.responseExcerpt, RESPONSE_EXCERPT_MAX),
                context_json: stringifyContext(event.context),
            });
            sinkLogger.debug(
                {
                    method: event.method,
                    url: event.url,
                    status: event.status,
                    durationMs: event.durationMs,
                    source: event.source,
                },
                "http_request recorded"
            );
        } catch (err) {
            sinkLogger.warn({ error: err, source: event.source }, "failed to insert http_request row");
        }
    }
}

export class MemoryHttpRequestSink implements HttpRequestSink {
    public readonly events: HttpRequestEvent[] = [];

    async record(event: HttpRequestEvent): Promise<void> {
        this.events.push(event);
    }
}

let defaultSink: HttpRequestSink | null = null;

export function getDefaultSink(): HttpRequestSink {
    if (!defaultSink) {
        defaultSink = new DbHttpRequestSink(getShopsDatabase());
    }

    return defaultSink;
}

export function resetDefaultSink(): void {
    defaultSink = null;
}

function truncate(value: string | null, max: number): string | null {
    if (value === null || value === undefined) {
        return null;
    }

    return value.length > max ? value.slice(0, max) : value;
}

function stringifyContext(ctx: Record<string, unknown>): string {
    try {
        return SafeJSON.stringify(ctx);
    } catch {
        return "{}";
    }
}
