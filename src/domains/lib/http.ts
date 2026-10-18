import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
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
    init: BunFetchRequestInit & { timeoutMs?: number; label?: string; maxBytes?: number } = {}
): Promise<HttpResponse<T>> {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, label = "http", maxBytes, ...rest } = init;
    const started = performance.now();
    const response = await fetch(url, { ...rest, signal: rest.signal ?? AbortSignal.timeout(timeoutMs) });
    // A redirect followed by hand carries nothing worth reading.
    const isManualRedirect = rest.redirect === "manual" && response.status >= 300 && response.status < 400;
    if (isManualRedirect) {
        await response.body?.cancel();
    }

    const text = isManualRedirect
        ? ""
        : maxBytes === undefined
          ? await response.text()
          : await readBounded(response, maxBytes);
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
const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
] as const) {
    NON_PUBLIC.addSubnet(network, prefix, "ipv4");
}

// "::/96" holds "::", "::1" and the old IPv4-compatible form. IPv4-mapped addresses (::ffff:7f00:1 and
// ::ffff:127.0.0.1 alike) need no entry: BlockList checks them against the IPv4 rules above.
for (const [network, prefix] of [
    ["::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
] as const) {
    NON_PUBLIC.addSubnet(network, prefix, "ipv6");
}

export function isPublicAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 0) {
        return false;
    }

    return !NON_PUBLIC.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * One public address for the host. Throws unless every address it resolves to is public, so an untrusted
 * redirect cannot reach this machine's network. Connect to the returned address, so a second DNS answer
 * (a rebinding) cannot swap in a private one between this check and the request.
 */
export async function resolvePublicAddress(hostname: string): Promise<string> {
    const host = hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address);
    return pickPublicAddress(hostname, addresses);
}

/** The address to connect to, or a throw when the list is empty or holds any non-public address. */
export function pickPublicAddress(hostname: string, addresses: string[]): string {
    const blocked = addresses.find((address) => !isPublicAddress(address));
    if (addresses.length === 0 || blocked) {
        throw new Error(`${hostname} resolves to a non-public address (${blocked ?? "none"})`);
    }

    return addresses[0];
}

/** The first `maxBytes` of the body; the rest is never downloaded. */
async function readBounded(response: Response, maxBytes: number): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) {
        return "";
    }

    const decoder = new TextDecoder();
    let text = "";
    let read = 0;
    while (read < maxBytes) {
        const { done, value } = await reader.read();
        if (done) {
            return text + decoder.decode();
        }

        const chunk = value.subarray(0, maxBytes - read);
        read += chunk.byteLength;
        text += decoder.decode(chunk, { stream: true });
    }

    await reader.cancel();
    return text + decoder.decode();
}

function redactUrl(url: string): string {
    return url.replace(/([?&](?:key|apikey|api_key|token|secret)[^=]*=)[^&]+/gi, "$1***");
}
