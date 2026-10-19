import { isValidLabel } from "@app/domains/lib/domain";
import type { Suggestor } from "@app/domains/lib/suggest/types";
import { allTlds } from "@app/domains/lib/tlds";
import type { Candidate } from "@app/domains/lib/types";

/**
 * Domain hacks: the name ends in a real TLD, so the dot falls inside the word.
 * "genesistech" -> genesiste.ch, "genesis" -> genes.is. Pure function, so it is testable offline.
 */
export function findHacks(text: string, tlds: Iterable<string>, minLabel = 2): Candidate[] {
    const word = text.toLowerCase().replace(/[^a-z0-9]/g, "");
    const out: Candidate[] = [];
    for (const tld of tlds) {
        if (!word.endsWith(tld) || word.length - tld.length < minLabel) {
            continue;
        }

        const label = word.slice(0, -tld.length);
        if (isValidLabel(label)) {
            out.push({ domain: `${label}.${tld}`, sources: ["hacks"], reason: `${label}.${tld} reads "${word}"` });
        }
    }

    return out;
}

/** Strings worth hacking: the joined seed, each word, adjacent pairs, and the seed with each word dropped. */
export function hackSources(words: string[]): string[] {
    const sources = new Set<string>([words.join("")]);
    for (const word of words) {
        sources.add(word);
    }

    for (let i = 0; i < words.length - 1; i++) {
        sources.add(words[i] + words[i + 1]);
    }

    return [...sources].filter((source) => source.length >= 4);
}

export const hacksSuggestor: Suggestor = {
    id: "hacks",
    label: "Domain hacks (the TLD finishes the word: genesiste.ch)",
    online: false,
    defaultOn: true,
    async suggest(context) {
        const tlds = await allTlds();
        return hackSources(context.words)
            .flatMap((source) => findHacks(source, tlds))
            .slice(0, context.limit);
    },
};
