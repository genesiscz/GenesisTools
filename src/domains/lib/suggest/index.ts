import { normalizeTld, parseDomain, seedWords } from "@app/domains/lib/domain";
import { affixSuggestor, exactSuggestor, shortSuggestor } from "@app/domains/lib/suggest/basic";
import { hacksSuggestor } from "@app/domains/lib/suggest/hacks";
import { aiSuggestor, synonymSuggestor } from "@app/domains/lib/suggest/online";
import type { SuggestContext, Suggestor } from "@app/domains/lib/suggest/types";
import { DEFAULT_TLDS } from "@app/domains/lib/tlds";
import type { Candidate } from "@app/domains/lib/types";
import { logger } from "@genesiscz/utils/logger";

export const SUGGESTORS: Suggestor[] = [
    exactSuggestor,
    hacksSuggestor,
    shortSuggestor,
    affixSuggestor,
    synonymSuggestor,
    aiSuggestor,
];

export function suggestorIds(): string[] {
    return SUGGESTORS.map((suggestor) => suggestor.id);
}

function suggestorById(id: string): Suggestor {
    const found = SUGGESTORS.find((suggestor) => suggestor.id === id);
    if (!found) {
        throw new Error(`Unknown suggestor "${id}". Known: ${suggestorIds().join(", ")}`);
    }

    return found;
}

export interface SuggestOptions {
    seed: string;
    tlds?: string[];
    /** Suggestor ids; default: every `defaultOn` suggestor. */
    suggestors?: string[];
    /** Added on top of the chosen set (e.g. `ai`). */
    extraSuggestors?: string[];
    offline?: boolean;
    description?: string;
    limitPerSuggestor?: number;
    avoid?: string[];
    liked?: string[];
    model?: string;
    account?: string;
}

export function buildContext(options: SuggestOptions): SuggestContext {
    const words = seedWords(options.seed);
    if (words.length === 0) {
        throw new Error(`No usable words in "${options.seed}"`);
    }

    return {
        words,
        joined: words.join(""),
        tlds: (options.tlds?.length ? options.tlds : DEFAULT_TLDS).map(normalizeTld),
        description: options.description,
        limit: options.limitPerSuggestor ?? 60,
        avoid: options.avoid,
        liked: options.liked,
        model: options.model,
        account: options.account,
    };
}

/** Run the chosen suggestors and merge duplicates (a name two suggestors found lists both sources). */
export async function suggest(options: SuggestOptions): Promise<Candidate[]> {
    const context = buildContext(options);
    const base = options.suggestors?.length
        ? options.suggestors.map(suggestorById)
        : SUGGESTORS.filter((suggestor) => suggestor.defaultOn);
    const requested = [...new Set([...base, ...(options.extraSuggestors ?? []).map(suggestorById)])];
    // --offline wins over --suggestors and --ai: nothing that needs the network runs, and the seed stays local.
    const chosen = options.offline ? requested.filter((suggestor) => !suggestor.online) : requested;
    const skipped = requested.filter((suggestor) => !chosen.includes(suggestor));
    if (skipped.length) {
        logger.warn(
            { skipped: skipped.map((suggestor) => suggestor.id) },
            "domains: --offline skips online suggestors"
        );
    }

    const batches = await Promise.all(
        chosen.map(async (suggestor) => {
            try {
                const found = await suggestor.suggest(context);
                logger.debug({ suggestor: suggestor.id, count: found.length }, "domains: suggestor done");
                return found;
            } catch (error) {
                logger.warn({ suggestor: suggestor.id, error }, "domains: suggestor failed");
                return [];
            }
        })
    );

    const merged = new Map<string, Candidate>();
    for (const candidate of batches.flat()) {
        const parsed = parseDomain(candidate.domain);
        if (!parsed) {
            continue;
        }

        const existing = merged.get(parsed.domain);
        if (existing) {
            existing.sources = [...new Set([...existing.sources, ...candidate.sources])];
            existing.reason ??= candidate.reason;
        } else {
            merged.set(parsed.domain, { ...candidate, domain: parsed.domain });
        }
    }

    return [...merged.values()];
}
