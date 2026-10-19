import { dnsProvider } from "@app/domains/lib/providers/dns";
import { rdapProvider } from "@app/domains/lib/providers/rdap";
import type { DomainProvider } from "@app/domains/lib/providers/types";
import { vercelProvider } from "@app/domains/lib/providers/vercel";
import { whoisProvider } from "@app/domains/lib/providers/whois";

/** Every provider, in default precedence: priced registrars first, then registry data, then DNS. */
export const PROVIDERS: DomainProvider[] = [vercelProvider, rdapProvider, whoisProvider, dnsProvider];

export function providerById(id: string): DomainProvider | undefined {
    return PROVIDERS.find((provider) => provider.id === id);
}

export function providerIds(): string[] {
    return PROVIDERS.map((provider) => provider.id);
}
