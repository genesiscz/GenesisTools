import { parkingServiceFor } from "@app/domains/lib/aftermarket";
import { parseDomain } from "@app/domains/lib/domain";
import { storage } from "@app/domains/lib/http";
import { dnsProvider } from "@app/domains/lib/providers/dns";
import { rdapProvider } from "@app/domains/lib/providers/rdap";
import { PROVIDERS, providerById } from "@app/domains/lib/providers/registry";
import type { DomainProvider } from "@app/domains/lib/providers/types";
import { whoisProvider } from "@app/domains/lib/providers/whois";
import type { CheckResult, ParsedDomain, ProviderVerdict } from "@app/domains/lib/types";
import { logger } from "@genesiscz/utils/logger";
import pLimit from "p-limit";

export interface CheckOptions {
    /** Provider ids to ask, all of them, in this order. Default: the smart chain (see `checkDomains`). */
    providers?: string[];
    /** Ignore cached results. */
    fresh?: boolean;
    concurrency?: number;
    /** Also ask RDAP about taken names (registrar, expiry). */
    details?: boolean;
    /** Write decisive results to the 6-hour cache. Off by default, so a lookup leaves no state behind. */
    store?: boolean;
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

    // A registry block is positive evidence, like a registration: it beats "available" and "premium".
    for (const status of ["reserved", "premium", "available"] as const) {
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

/** One batch call for every name the provider supports; failures leave names unanswered, never "available". */
async function askBatch(provider: DomainProvider, domains: ParsedDomain[]): Promise<Map<string, ProviderVerdict>> {
    if (!provider.checkBatch) {
        return new Map();
    }

    try {
        const supported: ParsedDomain[] = [];
        for (const domain of domains) {
            if (await provider.supports(domain.tld)) {
                supported.push(domain);
            }
        }

        return supported.length ? await provider.checkBatch(supported) : new Map();
    } catch (error) {
        logger.warn({ provider: provider.id, count: domains.length, error }, "domains: batch check failed");
        return new Map();
    }
}

const isDecisive = (verdict: ProviderVerdict | null | undefined) => !!verdict && verdict.status !== "unknown";

type VerdictMap = Map<string, ProviderVerdict[]>;

/**
 * Default chain, run as stages over the whole batch:
 * 1. DNS for every name (a delegated name is taken; no API spent).
 * 2. Batch-capable priced providers (Vercel: 200 names per call, with the premium flag).
 * 3. Per-name providers (RDAP, then WHOIS) for whatever is still undecided.
 * 4. With `details`, RDAP (or WHOIS where the TLD has no RDAP) for taken names, for registrar and expiry.
 */
async function smartStages(domains: ParsedDomain[], options: CheckOptions): Promise<VerdictMap> {
    const limit = pLimit(options.concurrency ?? 12);
    const verdicts: VerdictMap = new Map(domains.map((domain) => [domain.domain, []]));
    const push = (domain: string, verdict: ProviderVerdict | null | undefined) => {
        if (verdict) {
            verdicts.get(domain)?.push(verdict);
        }
    };
    const decided = (domain: ParsedDomain) => verdicts.get(domain.domain)?.some(isDecisive) ?? false;

    await Promise.all(domains.map((domain) => limit(async () => push(domain.domain, await ask(dnsProvider, domain)))));

    const others = PROVIDERS.filter((provider) => provider.id !== "dns");
    for (const provider of others.filter((p) => p.checkBatch)) {
        const pending = domains.filter((domain) => !decided(domain));
        if (pending.length === 0) {
            break;
        }

        const answers = await askBatch(provider, pending);
        for (const domain of pending) {
            push(domain.domain, answers.get(domain.domain));
        }
    }

    const single = others.filter((p) => !p.checkBatch);
    await Promise.all(
        domains
            .filter((domain) => !decided(domain))
            .map((domain) =>
                limit(async () => {
                    for (const provider of single) {
                        const verdict = await ask(provider, domain);
                        push(domain.domain, verdict);
                        if (isDecisive(verdict)) {
                            return;
                        }
                    }
                })
            )
    );

    if (options.details) {
        const needsDetails = domains.filter((domain) => {
            const list = verdicts.get(domain.domain) ?? [];
            return list.some((v) => v.status === "taken") && !list.some((v) => v.expiresAt);
        });
        await Promise.all(
            needsDetails.map((domain) =>
                limit(async () =>
                    push(domain.domain, (await ask(rdapProvider, domain)) ?? (await ask(whoisProvider, domain)))
                )
            )
        );
    }

    return verdicts;
}

async function explicitProviders(domains: ParsedDomain[], ids: string[], concurrency: number): Promise<VerdictMap> {
    const chosen = ids.map((id) => {
        const provider = providerById(id);
        if (!provider) {
            throw new Error(`Unknown provider "${id}". Known: ${PROVIDERS.map((p) => p.id).join(", ")}`);
        }

        return provider;
    });
    const limit = pLimit(concurrency);
    const verdicts: VerdictMap = new Map(domains.map((domain) => [domain.domain, []]));
    const push = (domain: string, verdict: ProviderVerdict | null | undefined) => {
        if (verdict) {
            verdicts.get(domain)?.push(verdict);
        }
    };

    for (const provider of chosen) {
        if (provider.checkBatch) {
            const answers = await askBatch(provider, domains);
            for (const domain of domains) {
                push(domain.domain, answers.get(domain.domain));
            }

            continue;
        }

        await Promise.all(domains.map((domain) => limit(async () => push(domain.domain, await ask(provider, domain)))));
    }

    return verdicts;
}

function cacheKey(domain: string, providers: string[] | undefined): string {
    return `results/${domain}${providers ? `.${providers.join("+")}` : ""}.json`;
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

    const results = new Map<string, CheckResult>();
    const pending: ParsedDomain[] = [];
    for (const domain of parsed.values()) {
        const cached = options.fresh
            ? null
            : await storage.getCacheFile<CheckResult>(cacheKey(domain.domain, options.providers), CACHE_TTL);
        if (cached && (!options.details || cached.status !== "taken" || cached.expiresAt)) {
            const result = { ...cached, cached: true };
            results.set(domain.domain, result);
            options.onResult?.(result);
        } else {
            pending.push(domain);
        }
    }

    logger.debug({ total: parsed.size, cached: results.size, invalid: invalid.length }, "domains: checking");
    const verdicts = options.providers
        ? await explicitProviders(pending, options.providers, options.concurrency ?? 12)
        : await smartStages(pending, options);

    for (const domain of pending) {
        const result = mergeVerdicts(domain.domain, verdicts.get(domain.domain) ?? []);
        results.set(domain.domain, result);
        options.onResult?.(result);
        if (options.store && result.status !== "unknown") {
            await storage.putCacheFile(cacheKey(domain.domain, options.providers), result, CACHE_TTL);
        }
    }

    return { results: [...parsed.keys()].flatMap((key) => results.get(key) ?? []), invalid };
}

/** One name, through the same pipeline as a batch of one. */
export async function checkDomain(parsed: ParsedDomain, options: CheckOptions = {}): Promise<CheckResult> {
    const { results } = await checkDomains([parsed.domain], options);
    return results[0] ?? mergeVerdicts(parsed.domain, []);
}
