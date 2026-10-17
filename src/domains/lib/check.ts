import { parkingServiceFor } from "@app/domains/lib/aftermarket";
import { parseDomain } from "@app/domains/lib/domain";
import { storage } from "@app/domains/lib/http";
import { dnsProvider } from "@app/domains/lib/providers/dns";
import { rdapProvider } from "@app/domains/lib/providers/rdap";
import { PROVIDERS, providerById } from "@app/domains/lib/providers/registry";
import type { DomainProvider } from "@app/domains/lib/providers/types";
import type { CheckResult, ParsedDomain, ProviderVerdict } from "@app/domains/lib/types";
import { logger } from "@genesiscz/utils/logger";
import pLimit from "p-limit";

export interface CheckOptions {
    /** Provider ids to ask, all of them, in this order. Default: the smart chain (see `checkDomain`). */
    providers?: string[];
    /** Ignore cached results. */
    fresh?: boolean;
    concurrency?: number;
    /** Also ask RDAP about taken names (registrar, expiry). */
    details?: boolean;
    onResult?: (result: CheckResult) => void;
}

const CACHE_TTL = "6 hours";

/** Fold provider answers into one status. A "taken" anywhere beats an "available" elsewhere. */
export function mergeVerdicts(domain: string, verdicts: ProviderVerdict[]): CheckResult {
    const first = <K extends keyof ProviderVerdict>(key: K) => verdicts.find((v) => v[key] !== undefined)?.[key];
    const nameservers = first("nameservers");
    const base = {
        domain,
        verdicts,
        checkedAt: new Date().toISOString(),
        expiresAt: first("expiresAt"),
        registrar: first("registrar"),
        nameservers,
    };

    const taken = verdicts.find((v) => v.status === "taken" || v.status === "for-sale");
    if (taken) {
        const parking = parkingServiceFor(nameservers ?? []);
        if (parking || taken.status === "for-sale") {
            return { ...base, provider: taken.provider, status: "for-sale", detail: parking ?? taken.detail };
        }

        return { ...base, provider: taken.provider, status: "taken", detail: taken.detail };
    }

    for (const status of ["premium", "available", "reserved"] as const) {
        const match = verdicts.find((v) => v.status === status);
        if (match) {
            const priced = match.price ? match : verdicts.find((v) => v.price);
            return { ...base, provider: match.provider, status, price: priced?.price, detail: match.detail };
        }
    }

    const last = verdicts.at(-1);
    return { ...base, provider: last?.provider ?? "none", status: "unknown", detail: last?.detail };
}

async function ask(provider: DomainProvider, parsed: ParsedDomain): Promise<ProviderVerdict | null> {
    try {
        if (!(await provider.supports(parsed.tld))) {
            return null;
        }

        return await provider.check(parsed);
    } catch (error) {
        logger.debug({ provider: provider.id, domain: parsed.domain, error }, "domains: provider failed");
        return { provider: provider.id, status: "unknown", detail: error instanceof Error ? error.message : "failed" };
    }
}

/**
 * Default chain: DNS first (a delegated name is taken, no API call spent), then the first priced
 * registrar that supports the TLD, then RDAP, stopping at the first decisive answer.
 */
async function smartChain(parsed: ParsedDomain, details: boolean): Promise<ProviderVerdict[]> {
    const verdicts: ProviderVerdict[] = [];
    const dns = await ask(dnsProvider, parsed);
    if (dns) {
        verdicts.push(dns);
    }

    if (dns?.status === "taken") {
        if (details) {
            const rdap = await ask(rdapProvider, parsed);
            if (rdap) {
                verdicts.push(rdap);
            }
        }

        return verdicts;
    }

    for (const provider of PROVIDERS.filter((p) => p.id !== "dns")) {
        if (!(await provider.status()).configured) {
            continue;
        }

        const verdict = await ask(provider, parsed);
        if (!verdict) {
            continue;
        }

        verdicts.push(verdict);
        if (verdict.status !== "unknown") {
            break;
        }
    }

    return verdicts;
}

export async function checkDomain(parsed: ParsedDomain, options: CheckOptions = {}): Promise<CheckResult> {
    const cacheKey = `results/${parsed.domain}${options.providers ? `.${options.providers.join("+")}` : ""}.json`;
    if (!options.fresh) {
        const cached = await storage.getCacheFile<CheckResult>(cacheKey, CACHE_TTL);
        if (cached && (!options.details || cached.status !== "taken" || cached.expiresAt)) {
            return { ...cached, cached: true };
        }
    }

    let verdicts: ProviderVerdict[];
    if (options.providers) {
        const chosen = options.providers.map((id) => {
            const provider = providerById(id);
            if (!provider) {
                throw new Error(`Unknown provider "${id}". Known: ${PROVIDERS.map((p) => p.id).join(", ")}`);
            }

            return provider;
        });
        const answers = await Promise.all(chosen.map((provider) => ask(provider, parsed)));
        verdicts = answers.filter((v): v is ProviderVerdict => v !== null);
    } else {
        verdicts = await smartChain(parsed, options.details ?? false);
    }

    const result = mergeVerdicts(parsed.domain, verdicts);
    if (result.status !== "unknown") {
        await storage.putCacheFile(cacheKey, result, CACHE_TTL);
    }

    return result;
}

export interface BatchResult {
    results: CheckResult[];
    invalid: string[];
}

export async function checkDomains(inputs: string[], options: CheckOptions = {}): Promise<BatchResult> {
    const invalid: string[] = [];
    const parsed = new Map<string, ParsedDomain>();
    for (const input of inputs) {
        const domain = parseDomain(input);
        if (domain) {
            parsed.set(domain.domain, domain);
        } else {
            invalid.push(input);
        }
    }

    const items = [...parsed.values()];
    logger.debug({ count: items.length, invalid: invalid.length }, "domains: checking");
    const limit = pLimit(options.concurrency ?? 12);
    const answers = await Promise.all(
        items.map((domain) =>
            limit(async () => {
                try {
                    const result = await checkDomain(domain, options);
                    options.onResult?.(result);
                    return result;
                } catch (error) {
                    logger.warn({ domain: domain.domain, error }, "domains: check failed");
                    return null;
                }
            })
        )
    );

    return { results: answers.filter((r): r is CheckResult => r !== null), invalid };
}
