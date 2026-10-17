import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";

export const storage = new Storage("domains");

const DEFAULT_TIMEOUT_MS = 15_000;

export interface HttpResponse<T> {
    status: number;
    /** Final URL after redirects. */
    url: string;
    body: T | null;
    text: string;
    headers: Headers;
}

/** One GET or POST with a deadline. Never throws for an HTTP status; throws only for a network failure. */
export async function request<T = unknown>(
    url: string,
    init: RequestInit & { timeoutMs?: number; label?: string } = {}
): Promise<HttpResponse<T>> {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, label = "http", ...rest } = init;
    const started = performance.now();
    const response = await fetch(url, { ...rest, signal: rest.signal ?? AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    logger.debug(
        { url: redactUrl(url), status: response.status, ms: Math.round(performance.now() - started) },
        `domains ${label}`
    );

    let body: T | null = null;
    if (text && (response.headers.get("content-type") ?? "").includes("json")) {
        try {
            body = SafeJSON.parse(text, { strict: true });
        } catch (error) {
            logger.debug({ url: redactUrl(url), error }, "domains: response is not valid JSON");
        }
    }

    return { status: response.status, url: response.url, body, text, headers: response.headers };
}

function redactUrl(url: string): string {
    return url.replace(/([?&](?:key|apikey|api_key|token|secret)[^=]*=)[^&]+/gi, "$1***");
}
