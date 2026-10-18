import { type CheckOptions, checkDomains } from "@app/domains/lib/check";
import { parseDomain, tldOf } from "@app/domains/lib/domain";
import { listPrice } from "@app/domains/lib/pricing";
import { scoreCandidate } from "@app/domains/lib/score";
import { type SuggestOptions, suggest } from "@app/domains/lib/suggest";
import type { Candidate, CheckResult, DomainPrice, DomainStatus } from "@app/domains/lib/types";
import { type VibeHit, vibeCheck } from "@app/domains/lib/vibe";
import { logger } from "@genesiscz/utils/logger";

export interface SearchOptions extends SuggestOptions {
    /** How many of the best-looking candidates to actually check (first round). */
    checkLimit?: number;
    /**
     * AI rounds. Round 1 runs every chosen suggestor; each later round runs only the AI suggestor,
     * told which names were taken and which free ones scored best. Needs `ai` among the suggestors.
     */
    rounds?: number;
    /** Drop results whose first-year price is above this (USD), or unknown (no quote and no TLD list price). */
    maxPrice?: number;
    /** Statuses to keep; default available + premium. */
    statuses?: DomainStatus[];
    /** Languages for the rude-meaning check; [] turns it off. */
    vibeLanguages?: string[];
    check?: Pick<CheckOptions, "fresh" | "concurrency" | "providers">;
    onProgress?: (done: number, total: number, round: number) => void;
}

export interface SearchHit {
    domain: string;
    score: number;
    sources: string[];
    reason?: string;
    result: CheckResult;
    vibe: VibeHit[];
    round: number;
}

export interface SearchOutcome {
    hits: SearchHit[];
    generated: number;
    checked: number;
    rounds: number;
}

interface Checked {
    candidate: Candidate;
    result: CheckResult;
    round: number;
}

async function checkRound({
    candidates,
    limit,
    round,
    options,
}: {
    candidates: Candidate[];
    limit: number;
    round: number;
    options: SearchOptions;
}): Promise<Checked[]> {
    const toCheck = candidates
        .map((candidate): Candidate => ({ ...candidate, score: scoreCandidate(candidate) }))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, limit);
    let done = 0;
    const { results } = await checkDomains(
        toCheck.map((candidate) => candidate.domain),
        { store: true, ...options.check, onResult: () => options.onProgress?.(++done, toCheck.length, round) }
    );
    const byDomain = new Map(results.map((result) => [result.domain, result]));
    return toCheck.flatMap((candidate) => {
        const result = byDomain.get(candidate.domain);
        return result ? [{ candidate, result, round }] : [];
    });
}

const isFree = (entry: Checked) => entry.result.status === "available";

/** TLD list prices for the given names, one lookup per TLD; a failed lookup leaves the TLD out. */
async function listPrices(domains: string[]): Promise<Map<string, DomainPrice>> {
    const prices = new Map<string, DomainPrice>();
    for (const tld of new Set(domains.map(tldOf))) {
        const price = await listPrice(tld).catch((error: unknown) => {
            logger.debug({ tld, error }, "domains: no list price for the estimate");
            return null;
        });
        if (price) {
            prices.set(tld, price);
        }
    }

    return prices;
}
const VIBE_PENALTY = 30;

export async function searchDomains(options: SearchOptions): Promise<SearchOutcome> {
    const rounds = Math.max(1, options.rounds ?? 1);
    const usesAi = options.suggestors?.includes("ai") || options.extraSuggestors?.includes("ai");
    const seen = new Set<string>();
    const checked: Checked[] = [];
    let generated = 0;

    for (let round = 1; round <= rounds; round++) {
        if (round > 1 && !usesAi) {
            break;
        }

        const free = checked
            .filter(isFree)
            .sort((a, b) => scoreCandidate(b.candidate, b.result) - scoreCandidate(a.candidate, a.result));
        const fresh = (
            await suggest({
                ...options,
                ...(round > 1
                    ? {
                          suggestors: ["ai"],
                          extraSuggestors: [],
                          avoid: checked.filter((entry) => !isFree(entry)).map((entry) => entry.candidate.domain),
                          liked: free.slice(0, 12).map((entry) => entry.candidate.domain),
                      }
                    : {}),
            })
        ).filter((candidate) => !seen.has(candidate.domain));
        generated += fresh.length;
        for (const candidate of fresh) {
            seen.add(candidate.domain);
        }

        const limit = round === 1 ? (options.checkLimit ?? 150) : fresh.length;
        checked.push(...(await checkRound({ candidates: fresh, limit, round, options })));
        logger.debug({ round, generated: fresh.length, checked: checked.length }, "domains: search round");
    }

    const statuses = new Set(options.statuses ?? ["available", "premium"]);
    const matching = checked.filter(({ result }) => statuses.has(result.status));
    // RDAP and WHOIS give no price: the TLD's list price stands in, so an unpriced name is neither free
    // under --max-price nor spared the price penalty in the ranking. With no price at all it fails a ceiling.
    const estimates = await listPrices(
        matching.filter(({ result }) => !result.price).map(({ result }) => result.domain)
    );
    const priceOf = (result: CheckResult) => result.price ?? estimates.get(tldOf(result.domain)) ?? undefined;
    const kept =
        options.maxPrice === undefined
            ? matching
            : matching.filter(({ result }) => {
                  const price = priceOf(result)?.registration;
                  return price !== undefined && price <= (options.maxPrice ?? 0);
              });

    const languages = options.vibeLanguages;
    const hits = await Promise.all(
        kept.map(async ({ candidate, result, round }): Promise<SearchHit> => {
            const label = parseDomain(candidate.domain)?.label ?? candidate.domain;
            const vibe = languages && languages.length === 0 ? [] : await vibeCheck(label, languages);
            return {
                domain: candidate.domain,
                // A rude reading in some language sinks a name, but it stays visible with its warning.
                score: Math.max(
                    0,
                    scoreCandidate(candidate, { ...result, price: priceOf(result) }) - (vibe.length ? VIBE_PENALTY : 0)
                ),
                sources: candidate.sources,
                reason: candidate.reason,
                result,
                round,
                vibe,
            };
        })
    );

    hits.sort((a, b) => b.score - a.score || (a.result.price?.registration ?? 0) - (b.result.price?.registration ?? 0));
    return { hits, generated, checked: checked.length, rounds };
}
