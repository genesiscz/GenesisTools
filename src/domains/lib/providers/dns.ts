import { resolveNs } from "node:dns/promises";
import type { DomainProvider } from "@app/domains/lib/providers/types";
import type { ParsedDomain, ProviderVerdict } from "@app/domains/lib/types";
import { logger } from "@genesiscz/utils/logger";

/** Nameservers of a domain, or [] when it has no delegation. Never throws. */
export async function lookupNameservers(domain: string): Promise<string[]> {
    try {
        return (await resolveNs(domain)).map((ns) => ns.toLowerCase().replace(/\.$/, ""));
    } catch (error) {
        logger.debug({ domain, error }, "domains: no NS records");
        return [];
    }
}

/**
 * Fast pre-filter. A delegated name is certainly taken; a name with no NS records proves nothing
 * (registered-but-undelegated names exist, and so do registry holds), so that case stays "unknown".
 */
export const dnsProvider: DomainProvider = {
    id: "dns",
    label: "DNS NS lookup (pre-filter)",
    capabilities: { availability: true, price: false, registration: false },

    async status() {
        return { configured: true, detail: "no auth; system resolver" };
    },

    async supports() {
        return true;
    },

    async check(parsed: ParsedDomain): Promise<ProviderVerdict> {
        const nameservers = await lookupNameservers(parsed.domain);
        if (nameservers.length > 0) {
            return { provider: "dns", status: "taken", nameservers, detail: "delegated" };
        }

        return { provider: "dns", status: "unknown", detail: "no NS records (not proof of availability)" };
    },
};
