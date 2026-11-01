import { randomUUID } from "node:crypto";
import { ImpersonatedHttpClient, type ImpersonatedResponse } from "@genesiscz/utils/http/impersonate/client";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { z } from "zod";
import {
    alternativesResponseSchema,
    categoryResponseSchema,
    discussionResponseSchema,
    facetsResponseSchema,
    placesResponseSchema,
    productResponseSchema,
    reviewsResponseSchema,
    searchResponseSchema,
    whisperResponseSchema,
} from "./schemas";
import { STOREFRONTS, type Storefront, type StorefrontId } from "./storefront";

/**
 * Raw Alza routes (the Android app's REST surface plus the server-rendered listing pages), sent through the
 * Chrome-fingerprint client because Cloudflare answers Bun's fetch with 403. Route inventory and DTO names:
 * lukabudik/alza-mcp-community docs/mobile-endpoint-coverage.md (MIT).
 */

const WEBAPI = "https://webapi.alza.cz";
const APP_USER_AGENT = "Alza/2026.17.0 (Android)";

/** `orderBy` of the v5 search body. */
export const SEARCH_SORTS = { relevance: 0, "price-asc": 1, "price-desc": 2, newest: 5, rating: 6 } as const;
export type SearchSort = keyof typeof SEARCH_SORTS;

export class AlzaApiError extends Error {
    constructor(
        message: string,
        readonly status: number
    ) {
        super(message);
        this.name = "AlzaApiError";
    }
}

export interface AlzaApiOptions {
    storefront?: StorefrontId;
    http?: ImpersonatedHttpClient;
    /** Bearer token for account routes (phase B). */
    accessToken?: () => Promise<string | undefined>;
}

export interface SearchBody {
    term: string;
    page: number;
    sort: SearchSort;
    producerIds?: number[];
}

export class AlzaApi {
    readonly storefront: Storefront;
    readonly visitorId = randomUUID();
    private readonly http: ImpersonatedHttpClient;
    private readonly ownsHttp: boolean;

    constructor(private readonly options: AlzaApiOptions = {}) {
        this.storefront = STOREFRONTS[options.storefront ?? "cz"];
        this.ownsHttp = !options.http;
        this.http = options.http ?? new ImpersonatedHttpClient({ label: "alza" });
    }

    async close(): Promise<void> {
        if (this.ownsHttp) {
            await this.http.close();
        }
    }

    async search(body: SearchBody) {
        return this.json(searchResponseSchema, "/services/restservice.svc/v5/search", {
            method: "POST",
            body: {
                searchTerm: body.term,
                id: 0,
                type: "PRODUCTION",
                typeId: 0,
                orderBy: SEARCH_SORTS[body.sort],
                page: body.page,
                availabilityType: 0,
                selectedBranches: [],
                params: [],
                producers: body.producerIds ?? [],
                sendPrices: false,
            },
        });
    }

    async product(id: number) {
        return this.json(productResponseSchema, `/api/router/legacy/catalog/product/${id}`);
    }

    /** The route takes a list but answers with the detail of one product. */
    async productByEan(ean: string) {
        return this.json(productResponseSchema, "/services/restservice.svc/v1/getProductByEANlist", {
            method: "POST",
            body: { eanList: [ean] },
        });
    }

    async alternatives(id: number) {
        return this.json(alternativesResponseSchema, `/services/restservice.svc/v1/alternatives/${id}`);
    }

    async category(id: number) {
        return this.json(categoryResponseSchema, `/services/restservice.svc/v1/category/${id}?T=CATEGORY&P=0`);
    }

    async facets(categoryId: number) {
        return this.json(
            facetsResponseSchema,
            `/services/restservice.svc/v3/params/${categoryId}?type=CATEGORY&typeId=0&search=`
        );
    }

    async reviews(id: number, opts: { limit: number; offset: number }) {
        const query = `country=${this.storefront.country}&limit=${opts.limit}&offset=${opts.offset}`;
        return this.json(reviewsResponseSchema, `${WEBAPI}/api/catalog/commodities/${id}/reviews?${query}`);
    }

    async discussion(id: number, opts: { pageStart: number; pageSize: number; parentId?: number }) {
        const query = new URLSearchParams({
            id: String(id),
            pageStart: String(opts.pageStart),
            pageSize: String(opts.pageSize),
        });
        if (opts.parentId !== undefined) {
            query.set("parentId", String(opts.parentId));
        }

        return this.json(discussionResponseSchema, `/services/restservice.svc/v1/getCommodityDiscussionPosts?${query}`);
    }

    async whisper(term: string) {
        const query = new URLSearchParams({
            country: this.storefront.country,
            visitor: this.visitorId,
            searchTerm: term,
        });
        return this.json(whisperResponseSchema, `${WEBAPI}/api/anonymous/search/whisperer/v1/whisper?${query}`);
    }

    /** AlzaBox lockers (type 1) nearest to a point, nearest first. */
    async places(opts: { latitude: number; longitude: number; limit: number }) {
        const query =
            `types%5B0%5D=1&latitude=${opts.latitude.toFixed(4)}&longitude=${opts.longitude.toFixed(4)}` +
            `&ordering=0&limit=${opts.limit}&offset=0`;
        return this.json(placesResponseSchema, `/api/salesNetwork/v1/places?${query}`);
    }

    /** A server-rendered storefront page (category listings). */
    async html(pathOrUrl: string): Promise<{ url: string; html: string }> {
        const url = this.absolute(pathOrUrl);
        const response = await this.http.request({
            url,
            headers: { accept: "text/html,application/xhtml+xml", "accept-language": this.storefront.acceptLanguage },
        });
        this.assertOk(url, response);
        return { url: response.url || url, html: response.text };
    }

    absolute(pathOrUrl: string): string {
        return pathOrUrl.startsWith("http") ? pathOrUrl : `${this.storefront.baseUrl}${pathOrUrl}`;
    }

    private async json<S extends z.ZodType>(
        schema: S,
        pathOrUrl: string,
        init: { method?: "GET" | "POST"; body?: unknown } = {}
    ): Promise<z.infer<S>> {
        const url = this.absolute(pathOrUrl);
        const headers: Record<string, string> = {
            accept: "application/json",
            "accept-language": this.storefront.acceptLanguage,
            "user-agent": APP_USER_AGENT,
            "Balancer-Guid": this.visitorId,
        };
        if (init.body !== undefined) {
            headers["content-type"] = "application/json";
        }

        const token = await this.options.accessToken?.();
        if (token) {
            headers.authorization = `Bearer ${token}`;
        }

        const response = await this.http.request({
            url,
            method: init.method ?? "GET",
            headers,
            body: init.body === undefined ? undefined : SafeJSON.stringify(init.body),
        });
        this.assertOk(url, response);

        let parsed: unknown;
        try {
            parsed = SafeJSON.parse(response.text, { strict: true });
        } catch (error) {
            logger.warn({ error, url, head: response.text.slice(0, 200) }, "alza answered non-JSON");
            throw new AlzaApiError(`Alza answered ${url} with a non-JSON body`, response.status);
        }

        const result = schema.safeParse(parsed);
        if (!result.success) {
            logger.warn({ url, issues: result.error.issues.slice(0, 5) }, "alza response shape changed");
            throw new AlzaApiError(
                `Alza changed the response shape of ${url}: ${result.error.message}`,
                response.status
            );
        }

        return result.data;
    }

    private assertOk(url: string, response: ImpersonatedResponse): void {
        if (response.status >= 200 && response.status < 300) {
            return;
        }

        const challenged = response.status === 403 && response.text.includes("<html");
        logger.warn({ url, status: response.status, challenged }, "alza request failed");
        throw new AlzaApiError(
            challenged
                ? `Cloudflare refused ${url} (HTTP 403). Retry later, or from another network.`
                : `Alza answered ${url} with HTTP ${response.status}: ${response.text.slice(0, 160)}`,
            response.status
        );
    }
}
