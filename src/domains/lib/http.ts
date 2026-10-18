import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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
    init: BunFetchRequestInit & { timeoutMs?: number; label?: string } = {}
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

/** Loopback, private, link-local, carrier-grade NAT, multicast and other non-public addresses. */
export function isPublicAddress(address: string): boolean {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (mapped) {
        return isPublicAddress(mapped);
    }

    if (isIP(address) === 4) {
        const [a, b] = address.split(".").map(Number);
        return !(
            a === 0 ||
            a === 10 ||
            a === 127 ||
            a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 192 && b === 0) ||
            (a === 198 && (b === 18 || b === 19))
        );
    }

    if (isIP(address) === 6) {
        const lower = address.toLowerCase();
        return !(
            lower === "::" ||
            lower === "::1" ||
            /^f[cd]/.test(lower) ||
            /^fe[89ab]/.test(lower) ||
            /^ff/.test(lower)
        );
    }

    return false;
}

/**
 * One public address for the host. Throws unless every address it resolves to is public, so an untrusted
 * redirect cannot reach this machine's network. Connect to the returned address, so a second DNS answer
 * (a rebinding) cannot swap in a private one between this check and the request.
 */
export async function resolvePublicAddress(hostname: string): Promise<string> {
    const host = hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address);
    const blocked = addresses.find((address) => !isPublicAddress(address));
    if (addresses.length === 0 || blocked) {
        throw new Error(`${hostname} resolves to a non-public address (${blocked ?? "none"})`);
    }

    return addresses[0];
}

function redactUrl(url: string): string {
    return url.replace(/([?&](?:key|apikey|api_key|token|secret)[^=]*=)[^&]+/gi, "$1***");
}
