/**
 * What a check concluded about one name.
 * - `available`: registrable at the normal registry price.
 * - `premium`: registrable, but the registry charges a premium price.
 * - `taken`: registered by someone.
 * - `for-sale`: registered, and parked with an aftermarket marketplace.
 * - `reserved`: blocked by the registry (not registrable by the public).
 * - `unknown`: no provider could decide.
 */
export type DomainStatus = "available" | "premium" | "taken" | "for-sale" | "reserved" | "unknown";

export const DOMAIN_STATUSES: readonly DomainStatus[] = [
    "available",
    "premium",
    "taken",
    "for-sale",
    "reserved",
    "unknown",
];

export function isDomainStatus(value: string): value is DomainStatus {
    return DOMAIN_STATUSES.some((status) => status === value);
}

export interface DomainPrice {
    /** First-year registration, in `currency`. */
    registration: number;
    renewal?: number;
    currency: string;
    /** Provider id that quoted the price. */
    provider: string;
    premium?: boolean;
}

export interface ProviderVerdict {
    provider: string;
    status: DomainStatus;
    price?: DomainPrice;
    /** Short human detail: an error, a parking host, a WHOIS line. */
    detail?: string;
    expiresAt?: string;
    registrar?: string;
    nameservers?: string[];
}

export interface CheckResult extends ProviderVerdict {
    domain: string;
    /** Every provider that answered, in the order they were asked. */
    verdicts: ProviderVerdict[];
    checkedAt: string;
    cached?: boolean;
}

export interface ParsedDomain {
    /** ASCII (punycode) form, lowercase. */
    domain: string;
    /** Everything left of the public suffix, e.g. `genesiste` in `genesiste.ch`. */
    label: string;
    /** Public suffix without the leading dot, e.g. `ch` or `co.uk`. */
    tld: string;
    /** Unicode form when the input was an IDN. */
    unicode?: string;
}

export interface Candidate {
    domain: string;
    /** Suggestor ids that produced it. */
    sources: string[];
    /** Why it was produced, e.g. `hack: genesiste|ch`. */
    reason?: string;
    score?: number;
}
