import logger from "@app/logger";
import { ApiClient, type ApiClientResponse } from "@app/utils/api/ApiClient";
import { SafeJSON } from "@app/utils/json";
// @ts-expect-error -- @hlidac-shopu/lib ships ESM with no .d.ts coverage
import { parseItemDetails } from "@hlidac-shopu/lib/shops.mjs";
import type { HttpRequestSink } from "@app/shops/lib/http-sink";
import type {
    Category,
    ListingOptions,
    RawProduct,
    SearchOptions,
    ShopApiClientConfig,
    ShopApiClientInterface,
    ShopCapabilities,
    ShopOrigin,
} from "@app/shops/api/ShopApiClient.types";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ShopApiClientConstructorConfig extends ShopApiClientConfig {
    sink?: HttpRequestSink;
}

const REQUEST_EXCERPT_BYTES = 1024;
const RESPONSE_EXCERPT_BYTES = 2048;

interface ParseItemDetailsResult {
    origin: string;
    itemId?: string | null;
    itemUrl: string;
}

export abstract class ShopApiClient extends ApiClient implements ShopApiClientInterface {
    abstract readonly shopOrigin: ShopOrigin;
    abstract readonly displayName: string;
    abstract readonly currency: string;
    abstract readonly capabilities: ShopCapabilities;

    protected readonly rateLimitPerSecond: number;
    protected readonly sink: HttpRequestSink | null;
    private lastRequestAt = 0;
    private readonly classLogger = logger.child({ component: "ShopApiClient" });

    constructor(config: ShopApiClientConstructorConfig = {}) {
        super({
            // Tight per-request budget: a slow Czech CDN edge node can hang
            // a fetch indefinitely (observed >7min on Lidl) which stalls
            // sitemap crawls. 5s + 2 retries caps wall-time at ~15s/url.
            timeoutMs: 5_000,
            retry: 2,
            ...config,
            loggerContext: { component: "ShopApiClient", ...config.loggerContext },
        });
        this.rateLimitPerSecond = config.rateLimitPerSecond ?? 2;
        this.sink = config.sink ?? null;
    }

    abstract getProduct(input: { url?: string; slug?: string }): Promise<RawProduct>;
    abstract listCategory(opts: ListingOptions): AsyncIterable<RawProduct>;
    abstract listCategories(): Promise<Category[]>;

    search?(opts: SearchOptions): Promise<RawProduct[]>;

    parseUrl(url: string): { shopOrigin: ShopOrigin; slug: string; itemId?: string } {
        const parsed = parseItemDetails(url) as ParseItemDetailsResult | null;
        if (!parsed || parsed.origin !== this.shopOrigin) {
            throw new Error(`URL ${url} does not belong to ${this.shopOrigin}`);
        }

        return {
            shopOrigin: parsed.origin,
            slug: parsed.itemId ?? parsed.itemUrl,
            itemId: parsed.itemId ?? undefined,
        };
    }

    protected async waitTurn(): Promise<void> {
        const minGap = 1000 / this.rateLimitPerSecond;
        const elapsed = Date.now() - this.lastRequestAt;
        if (elapsed < minGap) {
            await Bun.sleep(minGap - elapsed);
        }

        this.lastRequestAt = Date.now();
    }

    override async requestRaw<T>(
        method: Parameters<ApiClient["requestRaw"]>[0],
        path: string,
        body?: Parameters<ApiClient["requestRaw"]>[2],
        options?: Parameters<ApiClient["requestRaw"]>[3]
    ): Promise<ApiClientResponse<T>> {
        const startedAt = Date.now();
        const requestId = crypto.randomUUID().slice(0, 8);
        let status: number | undefined;
        let response: ApiClientResponse<T> | undefined;
        let error: unknown;
        try {
            response = await super.requestRaw<T>(method, path, body, options);
            status = response.status;
            return response;
        } catch (e) {
            error = e;
            throw e;
        } finally {
            const durationMs = Date.now() - startedAt;
            await this.emitToSink({
                method,
                url: response?.url ?? path,
                status,
                durationMs,
                requestId,
                body,
                response,
                error,
                operation: this.currentOperation(),
            });
        }
    }

    protected currentOperation(): string | undefined {
        return undefined;
    }

    private async emitToSink(args: {
        method: Method;
        url: string;
        status: number | undefined;
        durationMs: number;
        requestId: string;
        body: unknown;
        response: ApiClientResponse<unknown> | undefined;
        error: unknown;
        operation: string | undefined;
    }): Promise<void> {
        if (!this.sink) {
            return;
        }

        try {
            await this.sink.record({
                method: args.method,
                url: args.url,
                shopOrigin: this.shopOrigin,
                source: `ShopApiClient:${this.shopOrigin}`,
                operation: args.operation,
                status: args.status,
                durationMs: args.durationMs,
                requestId: args.requestId,
                requestExcerpt: excerptRequestBody(args.body),
                responseExcerpt: excerptResponseData(args.response?.data),
                error: formatError(args.error),
                ts: new Date().toISOString(),
                context: {},
            });
        } catch (sinkErr) {
            this.classLogger.warn({ shop: this.shopOrigin, error: sinkErr }, "http-sink.record failed");
        }
    }

    /** Test helper — exposes the protected requestRaw publicly. */
    requestRawPublic<T>(method: Method, path: string): Promise<ApiClientResponse<T>> {
        return this.requestRaw<T>(method, path);
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

function excerptRequestBody(body: unknown): string | null {
    if (body === undefined || body === null) {
        return null;
    }

    let text: string;
    if (typeof body === "string") {
        text = body;
    } else if (body instanceof FormData || body instanceof URLSearchParams) {
        text = String(body);
    } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        const byteLength = body instanceof ArrayBuffer ? body.byteLength : body.byteLength;
        return `<binary ${byteLength} bytes>`;
    } else {
        try {
            text = SafeJSON.stringify(body);
        } catch {
            text = String(body);
        }
    }

    return text.length > REQUEST_EXCERPT_BYTES ? text.slice(0, REQUEST_EXCERPT_BYTES) : text;
}

function excerptResponseData(data: unknown): string | null {
    if (data === undefined || data === null) {
        return null;
    }

    if (typeof data === "string") {
        return data.length > RESPONSE_EXCERPT_BYTES ? data.slice(0, RESPONSE_EXCERPT_BYTES) : data;
    }

    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const byteLength = data instanceof ArrayBuffer ? data.byteLength : data.byteLength;
        return `<binary ${byteLength} bytes>`;
    }

    try {
        const text = SafeJSON.stringify(data);
        return text.length > RESPONSE_EXCERPT_BYTES ? text.slice(0, RESPONSE_EXCERPT_BYTES) : text;
    } catch {
        return null;
    }
}
