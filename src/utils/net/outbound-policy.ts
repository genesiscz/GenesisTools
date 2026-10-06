import { lookup } from "node:dns/promises";

export type OutboundLookup = (hostname: string) => Promise<Array<{ address: string }>>;

let lookupImpl: OutboundLookup = (hostname) => lookup(hostname, { all: true, verbatim: true });

export function _setOutboundLookupForTest(fn: OutboundLookup): void {
    lookupImpl = fn;
}

export function _resetOutboundLookupForTest(): void {
    lookupImpl = (hostname) => lookup(hostname, { all: true, verbatim: true });
}

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

function ipv6Hextets(host: string): number[] | undefined {
    if (!host.includes(":")) {
        return undefined;
    }

    let text = host;
    const dotted = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);

    if (dotted?.[1]) {
        const octets = dotted[1].split(".").map(Number);
        if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
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

function ipv4Octets(host: string): number[] | undefined {
    const direct = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (direct) {
        const octets = direct.slice(1).map(Number);
        return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : undefined;
    }

    const hextets = ipv6Hextets(host);
    if (!hextets) {
        return undefined;
    }

    const leadingZero = hextets.slice(0, 5).every((hextet) => hextet === 0);
    const mapped = leadingZero && hextets[5] === 0xffff;
    const compatible = leadingZero && hextets[5] === 0 && (hextets[6] ?? 0) !== 0;
    if (!mapped && !compatible) {
        return undefined;
    }

    const high = hextets[6] ?? 0;
    const low = hextets[7] ?? 0;
    return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

export function isPrivateHost(hostname: string): boolean {
    const host = stripBrackets(hostname.trim().toLowerCase());
    if (PRIVATE_HOSTNAMES.has(host) || host.endsWith(".localhost") || host.endsWith(".local")) {
        return true;
    }

    const hextets = ipv6Hextets(host);
    if (hextets) {
        const allZero = hextets.every((hextet) => hextet === 0);
        const loopback = hextets.slice(0, 7).every((hextet) => hextet === 0) && hextets[7] === 1;
        const first = hextets[0] ?? 0;
        if (allZero || loopback || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) {
            return true;
        }
    }

    const octets = ipv4Octets(host);
    if (!octets) {
        return false;
    }

    const [first = 0, second = 0] = octets;
    return (
        first === 0 ||
        first === 127 ||
        first === 10 ||
        (first === 169 && second === 254) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168)
    );
}

function parseHttpUrl(target: string): URL {
    let url: URL;
    try {
        url = new URL(target);
    } catch {
        throw new OutboundUrlPolicyError(target, "not a valid absolute URL");
    }

    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new OutboundUrlPolicyError(target, `scheme ${url.protocol} is not http or https`);
    }

    return url;
}

function originIsPrivate(origin: string): boolean {
    try {
        return isPrivateHost(new URL(origin).hostname);
    } catch {
        return false;
    }
}

async function resolveAndRejectPrivate(url: URL, baseline: string): Promise<string[]> {
    let resolved: Array<{ address: string }>;
    try {
        resolved = await lookupImpl(stripBrackets(url.hostname));
    } catch (error) {
        throw new OutboundUrlPolicyError(
            url.href,
            `DNS resolution failed: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    if (resolved.length === 0) {
        throw new OutboundUrlPolicyError(url.href, "DNS resolution returned no addresses");
    }

    for (const entry of resolved) {
        if (isPrivateHost(entry.address)) {
            throw new OutboundUrlPolicyError(
                url.href,
                `${url.hostname} resolves to the private address ${entry.address}, and ${baseline} is public`
            );
        }
    }

    return resolved.map((entry) => entry.address);
}

export function assertNoOutboundEscalationSyntax(target: string, baseline: string): URL {
    const url = parseHttpUrl(target);
    if (!originIsPrivate(baseline) && isPrivateHost(url.hostname)) {
        throw new OutboundUrlPolicyError(
            target,
            `${baseline} is public, so it may not select the private address ${url.hostname}`
        );
    }

    return url;
}

export async function assertNoOutboundEscalation(target: string, baseline: string): Promise<URL> {
    const url = assertNoOutboundEscalationSyntax(target, baseline);
    if (!originIsPrivate(baseline)) {
        await resolveAndRejectPrivate(url, baseline);
    }

    return url;
}

export interface PublicOutboundTarget {
    url: URL;
    addresses: string[];
}

export async function resolvePublicOutboundTarget(target: string): Promise<PublicOutboundTarget> {
    const url = parseHttpUrl(target);
    if (isPrivateHost(url.hostname)) {
        throw new OutboundUrlPolicyError(target, `private address ${url.hostname}`);
    }

    return { url, addresses: await resolveAndRejectPrivate(url, target) };
}
