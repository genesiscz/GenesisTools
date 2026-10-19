import { request, storage } from "@app/domains/lib/http";
import type { DomainProvider } from "@app/domains/lib/providers/types";
import type { ParsedDomain, ProviderVerdict } from "@app/domains/lib/types";
import { logger } from "@genesiscz/utils/logger";

const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";

/** Registries that run RDAP but are missing from (or wrong in) the IANA bootstrap. */
const RDAP_OVERRIDES: Record<string, string> = {
    cz: "https://rdap.nic.cz/",
};

interface BootstrapFile {
    services: [string[], string[]][];
}

interface RdapEvent {
    eventAction: string;
    eventDate: string;
}

interface RdapEntity {
    roles?: string[];
    vcardArray?: [string, [string, Record<string, unknown>, string, unknown][]];
}

export interface RdapDomain {
    ldhName?: string;
    status?: string[];
    events?: RdapEvent[];
    entities?: RdapEntity[];
    nameservers?: { ldhName?: string }[];
}

let bootstrapPromise: Promise<Map<string, string>> | null = null;

async function loadBootstrap(): Promise<Map<string, string>> {
    const file = await storage.getFileOrPut<BootstrapFile>(
        "rdap/dns.json",
        async () => {
            const response = await request<BootstrapFile>(BOOTSTRAP_URL, { label: "rdap bootstrap" });
            if (!response.body) {
                throw new Error(`RDAP bootstrap download failed: HTTP ${response.status}`);
            }

            return response.body;
        },
        "1 day"
    );

    const map = new Map<string, string>();
    for (const [tlds, urls] of file.services) {
        const url = urls.find((candidate) => candidate.startsWith("https://")) ?? urls[0];
        for (const tld of tlds) {
            map.set(tld.toLowerCase(), url);
        }
    }

    for (const [tld, url] of Object.entries(RDAP_OVERRIDES)) {
        map.set(tld, url);
    }

    logger.debug({ tlds: map.size }, "domains: RDAP bootstrap loaded");
    return map;
}

export async function rdapBaseFor(tld: string): Promise<string | undefined> {
    bootstrapPromise ??= loadBootstrap().catch((error: unknown) => {
        bootstrapPromise = null;
        throw error;
    });

    try {
        const map = await bootstrapPromise;
        return map.get(tld) ?? map.get(tld.split(".").pop() ?? "");
    } catch (error) {
        logger.warn({ tld, error }, "domains: RDAP bootstrap unavailable");
        return undefined;
    }
}

export async function fetchRdap(domain: string, tld: string): Promise<{ status: number; body: RdapDomain | null }> {
    const base = await rdapBaseFor(tld);
    if (!base) {
        return { status: 0, body: null };
    }

    const url = `${base.replace(/\/?$/, "/")}domain/${domain}`;
    const response = await request<RdapDomain>(url, {
        label: "rdap",
        headers: { accept: "application/rdap+json, application/json" },
    });
    return { status: response.status, body: response.body };
}

export function rdapExpiry(body: RdapDomain): string | undefined {
    return body.events?.find((event) => event.eventAction === "expiration")?.eventDate;
}

export function rdapCreated(body: RdapDomain): string | undefined {
    return body.events?.find((event) => event.eventAction === "registration")?.eventDate;
}

export function rdapRegistrar(body: RdapDomain): string | undefined {
    const entity = body.entities?.find((candidate) => candidate.roles?.includes("registrar"));
    const fn = entity?.vcardArray?.[1]?.find((field) => field[0] === "fn");
    return typeof fn?.[3] === "string" ? fn[3] : undefined;
}

export function rdapNameservers(body: RdapDomain): string[] {
    return (body.nameservers ?? [])
        .map((ns) => ns.ldhName?.toLowerCase())
        .filter((ns): ns is string => typeof ns === "string");
}

export const rdapProvider: DomainProvider = {
    id: "rdap",
    label: "RDAP (registry, no auth)",
    capabilities: { availability: true, price: false, registration: true },

    async status() {
        return { configured: true, detail: "no auth; IANA bootstrap" };
    },

    async supports(tld) {
        return (await rdapBaseFor(tld)) !== undefined;
    },

    async check(parsed: ParsedDomain): Promise<ProviderVerdict> {
        const { status, body } = await fetchRdap(parsed.domain, parsed.tld);
        if (status === 404) {
            return { provider: "rdap", status: "available", detail: "not in registry (premium unknown)" };
        }

        if (status === 200 && body) {
            return {
                provider: "rdap",
                status: "taken",
                expiresAt: rdapExpiry(body),
                registrar: rdapRegistrar(body),
                nameservers: rdapNameservers(body),
                detail: body.status?.join(", "),
            };
        }

        if (status === 0) {
            return { provider: "rdap", status: "unknown", detail: "no RDAP server for this TLD" };
        }

        return { provider: "rdap", status: "unknown", detail: status === 429 ? "rate limited" : `HTTP ${status}` };
    },
};
