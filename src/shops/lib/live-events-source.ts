import { logger } from "@app/logger";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { sseBroadcaster } from "@app/shops/lib/sse-broadcaster";
import type { LiveCrawlProgressEvent, LiveHttpRequestEvent } from "@app/shops/types";

const POLL_INTERVAL_MS = 2_000;
const HTTP_BACKFILL_LIMIT = 100;
const CRAWL_BACKFILL_LIMIT = 30;
const HTTP_POLL_LIMIT = 200;

const log = logger.child({ component: "LiveEventsSource" });

let pollerStarted = false;
let lastSeenHttpId: number | null = null;
let lastSeenCrawlRunId: number | null = null;

interface HttpRow {
    id: number;
    ts: string;
    method: string;
    url: string;
    shop_origin: string | null;
    source: string;
    operation: string | null;
    status: number | null;
    duration_ms: number;
    request_id: string | null;
    crawl_run_id: number | null;
    product_slug: string | null;
    master_product_id: number | null;
    category_id: string | null;
    error: string | null;
    request_excerpt: string | null;
    response_excerpt: string | null;
}

const HTTP_COLUMNS = [
    "id",
    "ts",
    "method",
    "url",
    "shop_origin",
    "source",
    "operation",
    "status",
    "duration_ms",
    "request_id",
    "crawl_run_id",
    "product_slug",
    "master_product_id",
    "category_id",
    "error",
    "request_excerpt",
    "response_excerpt",
] as const;

interface CrawlRunRow {
    id: number;
    shop_origin: string;
    strategy: string;
    products_seen: number;
    products_new: number;
    prices_recorded: number;
    status: string;
    finished_at: string | null;
    started_at: string;
}

function rowToHttpEvent(row: HttpRow): LiveHttpRequestEvent {
    return {
        event: "http-request",
        id: row.id,
        ts: row.ts,
        method: row.method as LiveHttpRequestEvent["method"],
        url: row.url,
        shop_origin: row.shop_origin as LiveHttpRequestEvent["shop_origin"],
        source: row.source,
        operation: row.operation,
        status: row.status,
        duration_ms: row.duration_ms,
        request_id: row.request_id,
        crawl_run_id: row.crawl_run_id,
        product_slug: row.product_slug,
        master_product_id: row.master_product_id,
        category_id: row.category_id,
        error: row.error,
        request_excerpt: row.request_excerpt,
        response_excerpt: row.response_excerpt,
    };
}

function rowToCrawlEvent(row: CrawlRunRow): LiveCrawlProgressEvent {
    return {
        event: "crawl-progress",
        crawl_run_id: row.id,
        shop_origin: row.shop_origin,
        strategy: row.strategy,
        products_seen: row.products_seen,
        products_new: row.products_new,
        prices_recorded: row.prices_recorded,
        status: row.status as LiveCrawlProgressEvent["status"],
        ts: row.finished_at ?? row.started_at,
    };
}

/**
 * Fetch the last N events across http_requests + crawl_runs, sorted chronologically
 * (oldest first). Used as initial backfill for new SSE subscribers so the dashboard
 * shows the database's latest activity even when no live process is producing events.
 */
export async function getInitialLiveEvents(
    db: ShopsDatabase = getShopsDatabase()
): Promise<Array<{ event: string; data: unknown }>> {
    const httpRows = (await db
        .kysely()
        .selectFrom("http_requests")
        .select([...HTTP_COLUMNS])
        .orderBy("id", "desc")
        .limit(HTTP_BACKFILL_LIMIT)
        .execute()) as HttpRow[];

    const crawlRows = (await db
        .kysely()
        .selectFrom("crawl_runs")
        .select([
            "id",
            "shop_origin",
            "strategy",
            "products_seen",
            "products_new",
            "prices_recorded",
            "status",
            "finished_at",
            "started_at",
        ])
        .orderBy("id", "desc")
        .limit(CRAWL_BACKFILL_LIMIT)
        .execute()) as CrawlRunRow[];

    const events: Array<{ event: string; data: unknown; sortKey: string }> = [
        ...httpRows.map((r) => ({ event: "http-request", data: rowToHttpEvent(r), sortKey: r.ts })),
        ...crawlRows.map((r) => ({
            event: "crawl-progress",
            data: rowToCrawlEvent(r),
            sortKey: r.finished_at ?? r.started_at,
        })),
    ];

    events.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    return events.map(({ event, data }) => ({ event, data }));
}

async function pollOnce(db: ShopsDatabase): Promise<void> {
    if (lastSeenHttpId === null || lastSeenCrawlRunId === null) {
        return;
    }

    const httpRows = (await db
        .kysely()
        .selectFrom("http_requests")
        .select([...HTTP_COLUMNS])
        .where("id", ">", lastSeenHttpId)
        .orderBy("id", "asc")
        .limit(HTTP_POLL_LIMIT)
        .execute()) as HttpRow[];

    for (const row of httpRows) {
        sseBroadcaster.publish("http-request", rowToHttpEvent(row));
        lastSeenHttpId = row.id;
    }

    const crawlRows = (await db
        .kysely()
        .selectFrom("crawl_runs")
        .select([
            "id",
            "shop_origin",
            "strategy",
            "products_seen",
            "products_new",
            "prices_recorded",
            "status",
            "finished_at",
            "started_at",
        ])
        .where("id", ">", lastSeenCrawlRunId)
        .orderBy("id", "asc")
        .execute()) as CrawlRunRow[];

    for (const row of crawlRows) {
        sseBroadcaster.publish("crawl-progress", rowToCrawlEvent(row));
        lastSeenCrawlRunId = row.id;
    }
}

/**
 * Start the singleton DB poller that surfaces http_requests + crawl_runs writes
 * (from any process — CLI crawls, watch tick, daemon) to in-memory SSE subscribers.
 *
 * Idempotent. Heartbeat-only when no subscribers; the next subscribe() reactivates
 * via the broadcaster's heartbeat lifecycle.
 */
export function ensureLiveEventPoller(db: ShopsDatabase = getShopsDatabase()): void {
    if (pollerStarted) {
        return;
    }

    pollerStarted = true;

    void (async () => {
        try {
            const httpMax = (await db
                .kysely()
                .selectFrom("http_requests")
                .select(({ fn }) => fn.max("id").as("maxId"))
                .executeTakeFirst()) as { maxId: number | null } | undefined;
            const crawlMax = (await db
                .kysely()
                .selectFrom("crawl_runs")
                .select(({ fn }) => fn.max("id").as("maxId"))
                .executeTakeFirst()) as { maxId: number | null } | undefined;

            lastSeenHttpId = httpMax?.maxId ?? 0;
            lastSeenCrawlRunId = crawlMax?.maxId ?? 0;
            log.debug({ lastSeenHttpId, lastSeenCrawlRunId }, "live-events poller initialized");
        } catch (err) {
            log.error({ err }, "failed to initialize live-events poller — starting from 0");
            lastSeenHttpId = 0;
            lastSeenCrawlRunId = 0;
        }
    })();

    const interval = setInterval(() => {
        if (sseBroadcaster.subscriberCount() === 0) {
            return;
        }

        void pollOnce(db).catch((err) => log.warn({ err }, "live-events poll error"));
    }, POLL_INTERVAL_MS);

    interval.unref?.();
}

/**
 * Test-only reset of poller state. Not exposed in production paths.
 */
export function resetLiveEventsSourceForTest(): void {
    pollerStarted = false;
    lastSeenHttpId = null;
    lastSeenCrawlRunId = null;
}
