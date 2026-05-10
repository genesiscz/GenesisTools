import logger from "@app/logger";
import type {
    HlidacGetByUrlResult,
    HsDetailResponse,
    HsMetaS3,
    HsPriceHistoryS3,
} from "@app/shops/api/HlidacShopuClient.types";
import type { HttpRequestEvent, HttpRequestSink } from "@app/shops/lib/http-sink";
import { ApiClient, type ApiClientResponse } from "@app/utils/api/ApiClient";
import { SafeJSON } from "@app/utils/json";
// @ts-expect-error -- @hlidac-shopu/lib ships ESM with no .d.ts coverage
import { fetchDataSet, fetchShopsStats } from "@hlidac-shopu/lib/remoting.mjs";
// @ts-expect-error -- @hlidac-shopu/lib ships ESM with no .d.ts coverage
import { shopOrigin as deriveShopOrigin, itemSlug, parseItemDetails } from "@hlidac-shopu/lib/shops.mjs";

export interface HlidacShopuClientConfig {
    sink?: HttpRequestSink;
}

const RESPONSE_EXCERPT_MAX = 2048;
const log = logger.child({ component: "HlidacShopuClient" });

interface ParseItemDetailsResult {
    origin: string;
    itemId?: string | null;
    itemUrl: string;
}

export class HlidacShopuClient {
    private readonly api: ApiClient;
    private readonly s3: ApiClient;
    private readonly sink: HttpRequestSink | null;

    constructor(config: HlidacShopuClientConfig = {}) {
        this.sink = config.sink ?? null;
        this.api = new ApiClient({
            baseUrl: "https://api.hlidacshopu.cz/v2",
            loggerContext: { provider: "hlidacshopu", component: "extra" },
            retry: 1,
        });
        this.s3 = new ApiClient({
            baseUrl: "https://data.hlidacshopu.cz",
            loggerContext: { provider: "hlidacshopu", component: "s3" },
            retry: 1,
        });
    }

    async detail(productUrl: string): Promise<HsDetailResponse> {
        return this.timeAndRecord(
            "detail",
            "GET",
            `https://api.hlidacshopu.cz/v2/detail?url=${encodeURIComponent(productUrl)}`,
            null,
            () => fetchDataSet(productUrl) as Promise<HsDetailResponse>
        );
    }

    async shopsStats(): Promise<unknown> {
        return this.timeAndRecord("shopsStats", "GET", "https://api.hlidacshopu.cz/v2/shop-numbers", null, () =>
            fetchShopsStats()
        );
    }

    async dashboard(): Promise<unknown[]> {
        return this.requestThroughOwnClient(this.api, "GET", "/dashboard", "dashboard");
    }

    async blackFriday(year: number): Promise<unknown[]> {
        return this.requestThroughOwnClient(this.api, "GET", "/black-friday", "blackFriday", { year });
    }

    async reviewsStats(): Promise<unknown> {
        return this.requestThroughOwnClient(this.api, "GET", "/reviews-stats", "reviewsStats");
    }

    async priceHistoryS3(origin: string, slug: string): Promise<HsPriceHistoryS3> {
        return this.requestThroughOwnClient(
            this.s3,
            "GET",
            `/items/${encodeURIComponent(origin)}/${encodeURIComponent(slug)}/price-history.json`,
            "priceHistoryS3"
        );
    }

    async metaS3(origin: string, slug: string): Promise<HsMetaS3> {
        return this.requestThroughOwnClient(
            this.s3,
            "GET",
            `/items/${encodeURIComponent(origin)}/${encodeURIComponent(slug)}/meta.json`,
            "metaS3"
        );
    }

    async getByUrl(productUrl: string): Promise<HlidacGetByUrlResult> {
        const origin = deriveShopOrigin(productUrl) as string | null;
        const parsedDetails = parseItemDetails(productUrl) as ParseItemDetailsResult | null;
        if (!origin || !parsedDetails) {
            const detail = await this.detail(productUrl);
            return {
                source: "api",
                parsed: { origin: origin ?? "unknown", itemId: null, itemUrl: productUrl },
                history: null,
                detail,
            };
        }

        // @hlidac-shopu/lib's parser is incomplete for some shops (dm.cz, mojadm.sk,
        // hornbach.cz post-URL-redesign). When itemSlug returns undefined, Hlídač's
        // S3 bucket has no key for this URL — going to S3 anyway would build
        // `/items/<origin>/undefined/...` and 404. Skip to /v2/detail instead.
        const slug = itemSlug(productUrl) as string | undefined;
        if (!slug) {
            log.debug(
                { productUrl, origin },
                "no slug from @hlidac-shopu/lib — skipping S3, falling back to /v2/detail"
            );
            try {
                const detail = await this.detail(productUrl);
                return {
                    source: "api",
                    parsed: { origin, itemId: parsedDetails.itemId ?? null, itemUrl: parsedDetails.itemUrl },
                    history: null,
                    detail,
                };
            } catch (err) {
                log.debug({ err, productUrl }, "Hlídač /v2/detail also failed — shop URL not tracked");
                return {
                    source: "api",
                    parsed: { origin, itemId: parsedDetails.itemId ?? null, itemUrl: parsedDetails.itemUrl },
                    history: null,
                    detail: undefined,
                };
            }
        }
        try {
            const [history, meta] = await Promise.all([
                this.priceHistoryS3(origin, slug),
                this.metaS3(origin, slug).catch(() => undefined),
            ]);
            return {
                source: "s3",
                parsed: {
                    origin,
                    itemId: parsedDetails.itemId ?? null,
                    itemUrl: parsedDetails.itemUrl,
                },
                history,
                meta,
            };
        } catch (err) {
            log.debug({ err, productUrl }, "S3 path failed, falling back to /v2/detail");
            const detail = await this.detail(productUrl);
            return {
                source: "api",
                parsed: {
                    origin,
                    itemId: parsedDetails.itemId ?? null,
                    itemUrl: parsedDetails.itemUrl,
                },
                history: null,
                detail,
            };
        }
    }

    private async requestThroughOwnClient<T>(
        client: ApiClient,
        method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        path: string,
        operation: string,
        params?: Record<string, string | number | boolean>
    ): Promise<T> {
        const sourceLabel = client === this.s3 ? "HlidacShopuClient:s3" : `HlidacShopuClient:${operation}`;
        const startedAt = Date.now();
        const requestId = crypto.randomUUID().slice(0, 8);
        let response: ApiClientResponse<T> | undefined;
        let error: unknown;
        try {
            response = await client.requestRaw<T>(method, path, undefined, params ? { params } : undefined);
            return response.data;
        } catch (e) {
            error = e;
            throw e;
        } finally {
            const durationMs = Date.now() - startedAt;
            await this.recordSinkEvent({
                ts: new Date().toISOString(),
                method,
                url: response?.url ?? path,
                shopOrigin: null,
                source: sourceLabel,
                operation,
                status: response?.status,
                durationMs,
                requestId,
                requestExcerpt: null,
                responseExcerpt: serializeExcerpt(response?.data),
                error: formatError(error),
                context: {},
            });
        }
    }

    private async timeAndRecord<T>(
        operation: string,
        method: HttpRequestEvent["method"],
        url: string,
        shopOriginVal: string | null,
        run: () => Promise<T>
    ): Promise<T> {
        const startedAt = Date.now();
        const requestId = crypto.randomUUID().slice(0, 8);
        let error: unknown;
        try {
            return await run();
        } catch (e) {
            error = e;
            throw e;
        } finally {
            await this.recordSinkEvent({
                ts: new Date().toISOString(),
                method,
                url,
                shopOrigin: shopOriginVal,
                source: `HlidacShopuClient:${operation}`,
                operation,
                status: undefined,
                durationMs: Date.now() - startedAt,
                requestId,
                requestExcerpt: null,
                responseExcerpt: null,
                error: formatError(error),
                context: {},
            });
        }
    }

    private async recordSinkEvent(event: HttpRequestEvent): Promise<void> {
        if (!this.sink) {
            return;
        }

        try {
            await this.sink.record(event);
        } catch (sinkErr) {
            log.warn({ err: sinkErr, source: event.source }, "sink.record failed");
        }
    }
}

function formatError(error: unknown): string | null {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}`;
    }

    if (error) {
        return String(error);
    }

    return null;
}

function serializeExcerpt(data: unknown): string | null {
    if (data === null || data === undefined) {
        return null;
    }

    if (typeof data === "string") {
        return data.length > RESPONSE_EXCERPT_MAX ? data.slice(0, RESPONSE_EXCERPT_MAX) : data;
    }

    try {
        const text = SafeJSON.stringify(data);
        return text.length > RESPONSE_EXCERPT_MAX ? text.slice(0, RESPONSE_EXCERPT_MAX) : text;
    } catch {
        return null;
    }
}
