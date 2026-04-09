import type logger from "@app/logger";
import { getLogger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { type FetchError, ofetch, type ResponseType } from "ofetch";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ACCEPT_HEADER = "application/json, text/plain, */*";
const DEFAULT_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

type ApiClientMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type ApiClientScalar = string | number | boolean;
type ApiClientBody = BodyInit | Record<string, unknown> | unknown[] | null;

export type ApiClientParams = Record<string, ApiClientScalar | ApiClientScalar[] | null | undefined>;

export interface ApiClientConfig {
    baseUrl?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    userAgent?: string;
    retry?: number;
    loggerContext?: Record<string, unknown>;
}

export interface ApiClientRequestOptions {
    params?: ApiClientParams | URLSearchParams;
    headers?: Record<string, string>;
    timeoutMs?: number;
    responseType?: ResponseType;
    signal?: AbortSignal;
    retry?: number;
}

export interface ApiClientErrorDetails {
    method: ApiClientMethod;
    url: string;
    status?: number;
    statusText?: string;
    responseData?: unknown;
}

export interface ApiClientResponse<T> {
    data: T;
    headers: Headers;
    status: number;
    statusText: string;
    url: string;
}

export class ApiClientError extends Error {
    readonly method: ApiClientMethod;
    readonly url: string;
    readonly status?: number;
    readonly statusText?: string;
    readonly responseData?: unknown;

    constructor(message: string, details: ApiClientErrorDetails) {
        super(message);
        this.name = "ApiClientError";
        this.method = details.method;
        this.url = details.url;
        this.status = details.status;
        this.statusText = details.statusText;
        this.responseData = details.responseData;
    }
}

export function normalizeApiClientParams(params?: ApiClientRequestOptions["params"]): URLSearchParams | undefined {
    if (!params) {
        return undefined;
    }

    if (params instanceof URLSearchParams) {
        return params;
    }

    const searchParams = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) {
            continue;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                if (item !== undefined && item !== null) {
                    searchParams.append(key, String(item));
                }
            }

            continue;
        }

        searchParams.set(key, String(value));
    }

    return searchParams;
}

function stringifyResponseData(data: unknown): string | undefined {
    if (data === undefined || data === null || data === "") {
        return undefined;
    }

    if (typeof data === "string") {
        return data;
    }

    try {
        return SafeJSON.stringify(data);
    } catch {
        return String(data);
    }
}

function normalizeArrayBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
    if (data instanceof ArrayBuffer) {
        return data;
    }

    const copy = new Uint8Array(data.byteLength);
    copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return copy.buffer;
}

function isAbsoluteUrl(path: string): boolean {
    return /^https?:\/\//i.test(path);
}

function resolveUrl(baseUrl: string | undefined, path: string): string {
    if (isAbsoluteUrl(path) || !baseUrl) {
        return path;
    }

    // Strip leading slash so new URL() treats it as relative to the full base path.
    // "/foo" is origin-absolute and discards the base path; "foo" is base-relative and preserves it.
    const relativePath = path.startsWith("/") ? path.slice(1) : path;

    return new URL(relativePath, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

export class ApiClient {
    private readonly baseUrl?: string;
    private readonly defaultHeaders: Record<string, string>;
    private readonly defaultTimeoutMs: number;
    private readonly defaultRetry: number;
    private _requestLogger: ReturnType<typeof logger.child> | null = null;
    private readonly _loggerContext: Record<string, unknown>;

    constructor(config: ApiClientConfig = {}) {
        this.baseUrl = config.baseUrl;
        this.defaultTimeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.defaultRetry = config.retry ?? 0;
        this.defaultHeaders = {
            Accept: DEFAULT_ACCEPT_HEADER,
            "User-Agent": config.userAgent ?? DEFAULT_USER_AGENT,
            ...config.headers,
        };
        this._loggerContext = { component: "ApiClient", ...config.loggerContext };
    }

    private get requestLogger() {
        if (!this._requestLogger) {
            this._requestLogger = getLogger().child(this._loggerContext);
        }

        return this._requestLogger;
    }

    setHeader(name: string, value: string | undefined): void {
        if (value === undefined) {
            delete this.defaultHeaders[name];
            return;
        }

        this.defaultHeaders[name] = value;
    }

    async requestRaw<T>(
        method: ApiClientMethod,
        path: string,
        body?: ApiClientBody,
        options: ApiClientRequestOptions = {}
    ): Promise<ApiClientResponse<T>> {
        const url = this.resolveRequestUrl(path, options.params);
        const headers = {
            ...this.defaultHeaders,
            ...options.headers,
        };
        const startedAt = Date.now();

        this.requestLogger.debug({ method, url }, "api request started");

        try {
            const response = await ofetch.raw<T>(url, {
                method,
                body,
                headers,
                timeout: options.timeoutMs ?? this.defaultTimeoutMs,
                retry: options.retry ?? this.defaultRetry,
                signal: options.signal,
                onResponse: ({ response }) => {
                    this.requestLogger.debug(
                        {
                            method,
                            url,
                            status: response.status,
                            durationMs: Date.now() - startedAt,
                        },
                        "api request completed"
                    );
                },
            });

            return {
                data: response._data!,
                headers: response.headers,
                status: response.status,
                statusText: response.statusText,
                url: response.url,
            };
        } catch (error) {
            this.requestLogger.warn(
                {
                    method,
                    url,
                    durationMs: Date.now() - startedAt,
                    error,
                },
                "api request failed"
            );
            throw this.toApiClientError(error, method, url);
        }
    }

    async request<T>(
        method: ApiClientMethod,
        path: string,
        body?: ApiClientBody,
        options: ApiClientRequestOptions = {}
    ): Promise<T> {
        const response = await this.requestRaw<T>(method, path, body, options);
        return response.data;
    }

    async get<T>(path: string, options: ApiClientRequestOptions = {}): Promise<T> {
        return this.request<T>("GET", path, undefined, options);
    }

    async getText(path: string, options: ApiClientRequestOptions = {}): Promise<string> {
        const url = this.resolveRequestUrl(path, options.params);
        const headers = {
            ...this.defaultHeaders,
            ...options.headers,
        };
        const startedAt = Date.now();

        this.requestLogger.debug({ method: "GET", url }, "api text request started");

        try {
            return await ofetch<string, "text">(url, {
                method: "GET",
                headers,
                timeout: options.timeoutMs ?? this.defaultTimeoutMs,
                retry: options.retry ?? this.defaultRetry,
                signal: options.signal,
                responseType: "text",
                onResponse: ({ response }) => {
                    this.requestLogger.debug(
                        {
                            method: "GET",
                            url,
                            status: response.status,
                            durationMs: Date.now() - startedAt,
                        },
                        "api text request completed"
                    );
                },
            });
        } catch (error) {
            this.requestLogger.warn(
                {
                    method: "GET",
                    url,
                    durationMs: Date.now() - startedAt,
                    error,
                },
                "api text request failed"
            );
            throw this.toApiClientError(error, "GET", url);
        }
    }

    async getArrayBuffer(path: string, options: ApiClientRequestOptions = {}): Promise<ArrayBuffer> {
        const url = this.resolveRequestUrl(path, options.params);
        const headers = {
            ...this.defaultHeaders,
            ...options.headers,
        };
        const startedAt = Date.now();

        this.requestLogger.debug({ method: "GET", url }, "api binary request started");

        try {
            const response = await ofetch<ArrayBuffer | Uint8Array, "arrayBuffer">(url, {
                method: "GET",
                headers,
                timeout: options.timeoutMs ?? this.defaultTimeoutMs,
                retry: options.retry ?? this.defaultRetry,
                signal: options.signal,
                responseType: "arrayBuffer",
                onResponse: ({ response: rawResponse }) => {
                    this.requestLogger.debug(
                        {
                            method: "GET",
                            url,
                            status: rawResponse.status,
                            durationMs: Date.now() - startedAt,
                        },
                        "api binary request completed"
                    );
                },
            });

            return normalizeArrayBuffer(response);
        } catch (error) {
            this.requestLogger.warn(
                {
                    method: "GET",
                    url,
                    durationMs: Date.now() - startedAt,
                    error,
                },
                "api binary request failed"
            );
            throw this.toApiClientError(error, "GET", url);
        }
    }

    async post<T>(path: string, body?: ApiClientBody, options: ApiClientRequestOptions = {}): Promise<T> {
        return this.request<T>("POST", path, body, options);
    }

    async put<T>(path: string, body?: ApiClientBody, options: ApiClientRequestOptions = {}): Promise<T> {
        return this.request<T>("PUT", path, body, options);
    }

    async patch<T>(path: string, body?: ApiClientBody, options: ApiClientRequestOptions = {}): Promise<T> {
        return this.request<T>("PATCH", path, body, options);
    }

    async delete<T>(path: string, options: ApiClientRequestOptions = {}): Promise<T> {
        return this.request<T>("DELETE", path, undefined, options);
    }

    private resolveRequestUrl(path: string, params?: ApiClientRequestOptions["params"]): string {
        const url = resolveUrl(this.baseUrl, path);
        const searchParams = normalizeApiClientParams(params);

        if (!searchParams) {
            return url;
        }

        const resolvedUrl = new URL(url);
        searchParams.forEach((value, key) => {
            resolvedUrl.searchParams.append(key, value);
        });
        return resolvedUrl.toString();
    }

    private toApiClientError(error: unknown, method: ApiClientMethod, url: string): ApiClientError {
        const fetchError = error as FetchError<ApiClientErrorDetails["responseData"]>;
        const responseData = fetchError.data;
        const responseSuffix = stringifyResponseData(responseData);
        const status = fetchError.response?.status;
        const statusText = fetchError.response?.statusText;
        const statusLabel = status ? `${status}${statusText ? ` ${statusText}` : ""}` : fetchError.message;
        const message = `${method} ${url} failed: ${statusLabel}${responseSuffix ? ` — ${responseSuffix}` : ""}`;

        return new ApiClientError(message, {
            method,
            url,
            status,
            statusText,
            responseData,
        });
    }
}
