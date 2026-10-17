import type { DomainPrice, ParsedDomain, ProviderVerdict } from "@app/domains/lib/types";

export interface ProviderCapabilities {
    /** Can say whether a name is registrable. */
    availability: boolean;
    /** Can quote a price for a specific name (and so detect registry premiums). */
    price: boolean;
    /** Can show registration data (registrar, expiry, nameservers). */
    registration: boolean;
}

export interface ProviderStatus {
    configured: boolean;
    /** How it authenticates, or why it cannot: "no auth", "VERCEL_TOKEN", "Vercel CLI login". */
    detail: string;
}

export interface DomainProvider {
    id: string;
    label: string;
    capabilities: ProviderCapabilities;
    /** Read-only: never refreshes a token or writes a file. */
    status(): Promise<ProviderStatus>;
    supports(tld: string): Promise<boolean>;
    check(domain: ParsedDomain): Promise<ProviderVerdict>;
    /** Base (non-premium) first-year price for a TLD, when the provider publishes one. */
    tldPrice?(tld: string): Promise<DomainPrice | null>;
}
