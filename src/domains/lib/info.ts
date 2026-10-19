import {
    type CertificateSummary,
    certificateSummary,
    type LandingProbe,
    parkingServiceFor,
    probeLanding,
    type WaybackSummary,
    waybackSummary,
} from "@app/domains/lib/aftermarket";
import { checkDomain } from "@app/domains/lib/check";
import { listPrice } from "@app/domains/lib/pricing";
import { lookupNameservers } from "@app/domains/lib/providers/dns";
import {
    fetchRdap,
    rdapBaseFor,
    rdapCreated,
    rdapExpiry,
    rdapNameservers,
    rdapRegistrar,
} from "@app/domains/lib/providers/rdap";
import { whoisRecord } from "@app/domains/lib/providers/whois";
import { restrictionFor, type TldRestriction } from "@app/domains/lib/restrictions";
import type { CheckResult, DomainPrice, ParsedDomain } from "@app/domains/lib/types";
import { type VibeHit, vibeCheck } from "@app/domains/lib/vibe";
import { logger } from "@genesiscz/utils/logger";

export interface Registration {
    source: "rdap" | "whois" | "none";
    found: boolean;
    registrar?: string;
    created?: string;
    expires?: string;
    statuses: string[];
    nameservers: string[];
}

export interface DomainInfo {
    domain: string;
    unicode?: string;
    check: CheckResult;
    registration: Registration;
    dnsNameservers: string[];
    parking?: string;
    landing?: LandingProbe;
    listPrice: DomainPrice | null;
    restriction?: TldRestriction;
    history?: WaybackSummary;
    certificates?: CertificateSummary;
    vibe: VibeHit[];
}

async function settle<T>(label: string, promise: Promise<T>): Promise<T | undefined> {
    try {
        return await promise;
    } catch (error) {
        logger.debug({ label, error }, "domains: info source failed");
        return undefined;
    }
}

async function registrationFor(parsed: ParsedDomain): Promise<Registration> {
    if (await rdapBaseFor(parsed.tld)) {
        const { status, body } = await fetchRdap(parsed.domain, parsed.tld);
        return {
            source: "rdap",
            found: status === 200,
            registrar: body ? rdapRegistrar(body) : undefined,
            created: body ? rdapCreated(body) : undefined,
            expires: body ? rdapExpiry(body) : undefined,
            statuses: body?.status ?? [],
            nameservers: body ? rdapNameservers(body) : [],
        };
    }

    const record = await whoisRecord(parsed);
    if (!record) {
        return { source: "none", found: false, statuses: [], nameservers: [] };
    }

    return {
        source: "whois",
        found: record.found,
        registrar: record.registrar,
        expires: record.expiresAt,
        statuses: [],
        nameservers: record.nameservers,
    };
}

export async function domainInfo(parsed: ParsedDomain, { history = true } = {}): Promise<DomainInfo> {
    const [check, registration, dns, list, wayback, certificates, vibe] = await Promise.all([
        checkDomain(parsed, { fresh: true }),
        settle("registration", registrationFor(parsed)),
        lookupNameservers(parsed.domain),
        settle("price", listPrice(parsed.tld)),
        history ? settle("wayback", waybackSummary(parsed.domain)) : Promise.resolve(undefined),
        history ? settle("crt.sh", certificateSummary(parsed.domain)) : Promise.resolve(undefined),
        vibeCheck(parsed.label),
    ]);

    const reg = registration ?? { source: "none" as const, found: false, statuses: [], nameservers: [] };
    const taken = reg.found || check.status === "taken" || check.status === "for-sale";
    const landing = taken && dns.length ? await settle("landing", probeLanding(parsed.domain)) : undefined;
    const parking = parkingServiceFor([...dns, ...reg.nameservers]) ?? landing?.marketplace;
    return {
        domain: parsed.domain,
        unicode: parsed.unicode,
        check: parking && check.status === "taken" ? { ...check, status: "for-sale", detail: parking } : check,
        registration: reg,
        dnsNameservers: dns,
        parking,
        landing,
        listPrice: list ?? null,
        restriction: restrictionFor(parsed.tld),
        history: wayback,
        certificates,
        vibe,
    };
}
