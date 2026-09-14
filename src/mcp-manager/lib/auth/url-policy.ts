import { lookup } from "node:dns/promises";

type LookupFn = (hostname: string) => Promise<Array<{ address: string }>>;

let lookupImpl: LookupFn = (hostname) => lookup(hostname, { all: true, verbatim: true });

/** Same seam as _setMcpFetchForTest in fetch.ts: the DNS guard must be testable offline. */
export function _setLookupForTest(fn: LookupFn): void {
    lookupImpl = fn;
}

export function _resetLookupForTest(): void {
    lookupImpl = (hostname) => lookup(hostname, { all: true, verbatim: true });
}

/**
 * Where discovery is allowed to send a request.
 *
 * Every URL in the RFC 9728 / RFC 8414 chain after the first one is chosen by the
 * REMOTE server: `resource_metadata` comes out of its `WWW-Authenticate` header, and
 * `authorization_servers[0]` out of a document it serves. A hostile or compromised MCP
 * endpoint can therefore aim this process at `169.254.169.254`, at a private LAN host,
 * or at a loopback port that another local service is listening on.
 *
 * The rule is "no escalation": a PUBLIC MCP server may only send us to public hosts. A
 * server we already reach over loopback or a private address is by definition already
 * inside that boundary, so it keeps working — which is what local development and the
 * integration tests need.
 */

const PRIVATE_HOSTNAMES = new Set(["localhost", "0.0.0.0"]);

export class OutboundUrlPolicyError extends Error {
    constructor(url: string, reason: string) {
        super(`refused to fetch ${url}: ${reason}`);
        this.name = "OutboundUrlPolicyError";
    }
}

function stripBrackets(hostname: string): string {
    return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * The eight hextets of an IPv6 literal, or undefined when `host` is not one.
 *
 * 🛑 This exists because `new URL()` REWRITES the address before anything downstream
 * sees it: `http://[::ffff:192.168.1.10]/` has hostname `[::ffff:c0a8:10a]`. A check
 * written against the dotted spelling therefore matches nothing that ever arrives
 * through a URL, which is how every IPv4-mapped address — loopback included — walked
 * past the first version of this file. Measured 2026-09-14.
 */
function ipv6Hextets(host: string): number[] | undefined {
    if (!host.includes(":")) {
        return undefined;
    }

    let text = host;
    // A trailing dotted quad is legal IPv6 syntax (`::ffff:192.168.1.10`). Fold it into
    // two hextets so the rest of this function only deals with one representation.
    const dotted = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);

    if (dotted?.[1]) {
        const octets = dotted[1].split(".").map(Number);

        if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
            return undefined;
        }

        const high = (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16);
        const low = (((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16);
        text = `${text.slice(0, -dotted[1].length)}${high}:${low}`;
    }

    const halves = text.split("::");

    if (halves.length > 2) {
        return undefined;
    }

    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const missing = 8 - head.length - tail.length;

    if (halves.length === 1 ? head.length !== 8 : missing < 0) {
        return undefined;
    }

    const groups = halves.length === 1 ? head : [...head, ...Array<string>(missing).fill("0"), ...tail];
    const hextets = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN));

    return hextets.some(Number.isNaN) ? undefined : hextets;
}

/** The four octets of an IPv4 address, whether written directly or carried inside IPv6. */
function ipv4Octets(host: string): number[] | undefined {
    const direct = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);

    if (direct) {
        const octets = direct.slice(1).map(Number);

        return octets.every((n) => n >= 0 && n <= 255) ? octets : undefined;
    }

    const hextets = ipv6Hextets(host);

    if (!hextets) {
        return undefined;
    }

    const leadingZero = hextets.slice(0, 5).every((h) => h === 0);

    // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, deprecated but still routed).
    // ::1 and :: are loopback/unspecified, not IPv4, and are handled by the caller.
    const mapped = leadingZero && hextets[5] === 0xffff;
    const compatible = leadingZero && hextets[5] === 0 && (hextets[6] ?? 0) !== 0;

    if (!mapped && !compatible) {
        return undefined;
    }

    const high = hextets[6] ?? 0;
    const low = hextets[7] ?? 0;

    return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

/** True for loopback, link-local, private and unique-local addresses, and for mDNS names. */
export function isPrivateHost(hostname: string): boolean {
    const host = stripBrackets(hostname.trim().toLowerCase());

    if (PRIVATE_HOSTNAMES.has(host)) {
        return true;
    }

    if (host.endsWith(".localhost") || host.endsWith(".local")) {
        return true;
    }

    const hextets = ipv6Hextets(host);

    if (hextets) {
        const allZero = hextets.every((h) => h === 0);
        const loopback = hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1;

        if (allZero || loopback) {
            return true;
        }

        const first = hextets[0] ?? 0;

        // fc00::/7 unique local, fe80::/10 link local.
        if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) {
            return true;
        }
    }

    const octets = ipv4Octets(host);

    if (!octets) {
        return false;
    }

    const [a = 0, b = 0] = octets;

    return (
        a === 0 ||
        a === 127 ||
        a === 10 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168)
    );
}

function originIsPrivate(origin: string): boolean {
    try {
        return isPrivateHost(new URL(origin).hostname);
    } catch {
        return false;
    }
}

/**
 * Throws unless `target` is a legal destination for discovery started at `origin`.
 * `origin` is the MCP server URL the user configured, i.e. the trust baseline.
 *
 * Checks the literal host only. Use {@link assertDiscoveryTarget} for the full check.
 */
export function assertDiscoveryTargetSyntax(target: string, origin: string): URL {
    let url: URL;

    try {
        url = new URL(target);
    } catch {
        throw new OutboundUrlPolicyError(target, "not a valid absolute URL");
    }

    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new OutboundUrlPolicyError(target, `scheme ${url.protocol} is not http or https`);
    }

    if (!originIsPrivate(origin) && isPrivateHost(url.hostname)) {
        throw new OutboundUrlPolicyError(
            target,
            `${origin} is a public server, so it may not redirect discovery to the private address ${url.hostname}`
        );
    }

    return url;
}

/**
 * The full check: syntax, literal host, and every address the hostname RESOLVES to.
 *
 * A literal-host check alone is not an SSRF control. `evil.example.com` is a public
 * name that can have an A record of `127.0.0.1` or `169.254.169.254`, and the first
 * version of this file would have fetched it.
 *
 * ⚠️ Residual risk, stated rather than implied: this validates the resolution and then
 * hands the HOSTNAME to `fetch`, which resolves again. A record that changes between
 * the two lookups (DNS rebinding) is not caught. Closing that needs the connection
 * pinned to the validated address, and Bun's `fetch` exposes neither a `lookup` hook
 * nor a custom dispatcher, so it cannot be done here without hand-rolling the
 * transport and losing TLS verification. The resolution check removes the easy attack;
 * the rebinding window remains and is why the gateway itself binds loopback-only.
 */
export async function assertDiscoveryTarget(target: string, origin: string): Promise<URL> {
    const url = assertDiscoveryTargetSyntax(target, origin);

    if (originIsPrivate(origin)) {
        return url;
    }

    let resolved: Array<{ address: string }>;

    try {
        resolved = await lookupImpl(url.hostname);
    } catch {
        // A name that does not resolve cannot be fetched either. Let the request fail
        // on its own terms rather than inventing a policy error for a DNS outage.
        return url;
    }

    for (const entry of resolved) {
        if (isPrivateHost(entry.address)) {
            throw new OutboundUrlPolicyError(
                target,
                `${url.hostname} resolves to the private address ${entry.address}, and ${origin} is a public server`
            );
        }
    }

    return url;
}
