import { connect } from "node:net";
import { storage } from "@app/domains/lib/http";
import { rdapBaseFor } from "@app/domains/lib/providers/rdap";
import type { DomainProvider } from "@app/domains/lib/providers/types";
import type { ParsedDomain, ProviderVerdict } from "@app/domains/lib/types";
import { logger } from "@genesiscz/utils/logger";

const IANA_WHOIS = "whois.iana.org";
const TIMEOUT_MS = 12_000;

/** Phrases registries use for "no such domain". Matched case-insensitively against the whole reply. */
const NOT_FOUND_PATTERNS = [
    /no match for/i,
    /^no match/im,
    /not found/i,
    /no data found/i,
    /no entries found/i,
    /no object found/i,
    /status:\s*(free|available)/i,
    /domain (name )?not (found|registered)/i,
    /is available for (registration|purchase)/i,
    /the queried object does not exist/i,
    /no information available/i,
    /^%% no entries found/im,
];

/** Replies that mean "ask again later", which must never read as "available". */
const THROTTLE_PATTERNS = [/limit exceeded/i, /too many (queries|requests)/i, /try again later/i, /quota/i];

/** Some registries need a flag before the name to return the plain record. */
const QUERY_FORMAT: Record<string, (domain: string) => string> = {
    de: (domain) => `-T dn,ace ${domain}`,
    jp: (domain) => `${domain}/e`,
};

export function whoisQuery(server: string, query: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = connect({ host: server, port: 43 });
        const chunks: Buffer[] = [];
        socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error(`WHOIS ${server}: timed out`)));
        socket.on("connect", () => socket.write(`${query}\r\n`));
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        socket.on("error", reject);
        socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
}

/** The registry WHOIS host for a TLD, from IANA's own WHOIS (`whois:` line), cached for a week. */
export async function whoisServerFor(tld: string): Promise<string | null> {
    const servers = (await storage.getCacheFile<Record<string, string | null>>("whois/servers.json", "7 days")) ?? {};
    if (tld in servers) {
        return servers[tld];
    }

    const reply = await whoisQuery(IANA_WHOIS, tld);
    const host = reply.match(/^whois:[ \t]*(\S+)/im)?.[1]?.toLowerCase();
    const server = host?.includes(".") ? host : null;
    servers[tld] = server;
    await storage.putCacheFile("whois/servers.json", servers, "7 days");
    logger.debug({ tld, server }, "domains: WHOIS server resolved");
    return server;
}

function stripComments(reply: string): string {
    return reply
        .split("\n")
        .filter((line) => !/^\s*[%#]/.test(line))
        .join("\n");
}

export type WhoisVerdict = "available" | "taken" | "throttled";

export function interpretWhois(reply: string): WhoisVerdict {
    if (THROTTLE_PATTERNS.some((pattern) => pattern.test(reply)) && reply.length < 600) {
        return "throttled";
    }

    // Only the head, without comment banners: long legal text can say "not found" in another sense.
    const head = stripComments(reply).slice(0, 1500);
    if (NOT_FOUND_PATTERNS.some((pattern) => pattern.test(head))) {
        return "available";
    }

    return "taken";
}

/** Fields worth showing from a raw record; each registry formats them differently. */
export function whoisFields(reply: string): { registrar?: string; expiresAt?: string; nameservers: string[] } {
    const pick = (...patterns: RegExp[]) =>
        patterns.map((re) => reply.match(re)?.[1]?.trim()).find((value) => value !== undefined && value !== "");
    const nameservers = [...reply.matchAll(/^[ \t]*(?:name server|nserver|nameserver)s?:[ \t]*(\S+)/gim)].map((m) =>
        m[1].toLowerCase().replace(/\.$/, "")
    );
    return {
        registrar: pick(/^[ \t]*registrar(?: name)?:[ \t]*(\S.*)$/im, /^registrar:[ \t]*\r?\n[ \t]+name:[ \t]*(.+)$/im),
        expiresAt: pick(/^[ \t]*(?:registry expiry date|expir\w* date|expire[sd]?|paid-till):[ \t]*(\S.*)$/im),
        nameservers: [...new Set(nameservers)],
    };
}

export interface WhoisRecord {
    server: string;
    found: boolean;
    registrar?: string;
    expiresAt?: string;
    nameservers: string[];
}

/** The raw registry record for a name, parsed; null when the TLD has no WHOIS server. */
export async function whoisRecord(parsed: ParsedDomain): Promise<WhoisRecord | null> {
    const server = await whoisServerFor(parsed.tld);
    if (!server) {
        return null;
    }

    const reply = await whoisQuery(server, QUERY_FORMAT[parsed.tld]?.(parsed.domain) ?? parsed.domain);
    return { server, found: interpretWhois(reply) === "taken", ...whoisFields(reply) };
}

/** Port-43 WHOIS. Used for TLDs with no RDAP server (.io, .co, .sh, .eu, .gg ...). */
export const whoisProvider: DomainProvider = {
    id: "whois",
    label: "WHOIS port 43 (fallback, no auth)",
    capabilities: { availability: true, price: false, registration: true },

    async status() {
        return { configured: true, detail: "no auth; server from whois.iana.org" };
    },

    async supports(tld) {
        if (await rdapBaseFor(tld)) {
            return false;
        }

        return (await whoisServerFor(tld)) !== null;
    },

    async check(parsed: ParsedDomain): Promise<ProviderVerdict> {
        const server = await whoisServerFor(parsed.tld);
        if (!server) {
            return { provider: "whois", status: "unknown", detail: "no WHOIS server" };
        }

        const reply = await whoisQuery(server, QUERY_FORMAT[parsed.tld]?.(parsed.domain) ?? parsed.domain);
        const verdict = interpretWhois(reply);
        if (verdict === "throttled") {
            return { provider: "whois", status: "unknown", detail: `${server} rate limited` };
        }

        if (verdict === "available") {
            return { provider: "whois", status: "available", detail: `${server}: no record (premium unknown)` };
        }

        return { provider: "whois", status: "taken", ...whoisFields(reply), detail: server };
    },
};
