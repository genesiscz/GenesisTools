import { isValidLabel } from "@app/domains/lib/domain";
import { combine, type Suggestor } from "@app/domains/lib/suggest/types";

/** Prefixes and suffixes startups put around a taken name (get-, try-, -hq, -labs). */
export const PREFIXES = ["get", "try", "use", "go", "join", "hey", "meet", "with", "the", "my", "hello", "run"];
export const SUFFIXES = ["hq", "labs", "app", "hub", "dev", "studio", "works", "tech", "ly", "ify", "now", "team"];

const VOWELS = /[aeiouy]/g;

/** "genesis" -> "gnss"; keeps the first letter so the word stays recognizable. */
export function dropVowels(word: string): string {
    return word[0] + word.slice(1).replace(VOWELS, "");
}

/** Overlap blend: "genesis" + "sister" -> "genesister"; plain concatenation when nothing overlaps. */
export function blend(a: string, b: string): string {
    for (let size = Math.min(a.length, b.length) - 1; size >= 2; size--) {
        if (a.endsWith(b.slice(0, size))) {
            return a + b.slice(size);
        }
    }

    return a + b;
}

/** Short forms of a seed: prefixes of the head word joined with the rest, acronyms, vowel drops. */
export function shortForms(words: string[]): string[] {
    const [head, ...rest] = words;
    if (!head) {
        return [];
    }

    const tail = rest.join("");
    const forms = new Set<string>();
    for (let size = 3; size < head.length; size++) {
        forms.add(head.slice(0, size) + tail);
    }

    forms.add(dropVowels(head));
    if (tail) {
        forms.add(dropVowels(head) + tail);
        forms.add(blend(head, tail));
    }

    return [...forms].filter((form) => form.length >= 3 && isValidLabel(form) && form !== words.join(""));
}

export const exactSuggestor: Suggestor = {
    id: "exact",
    label: "The seed itself on every TLD (genesistech.com, genesis-tech.cz)",
    online: false,
    defaultOn: true,
    async suggest(context) {
        const labels = new Set([context.joined]);
        if (context.words.length > 1) {
            labels.add(context.words.join("-"));
            labels.add(context.words[0]);
        }

        return combine({ labels: [...labels], tlds: context.tlds, source: "exact" }).slice(0, context.limit);
    },
};

export const affixSuggestor: Suggestor = {
    id: "affixes",
    label: "Prefixes and suffixes (getgenesis.com, genesishq.dev)",
    online: false,
    defaultOn: true,
    async suggest(context) {
        const bases = new Set([context.joined, context.words[0]]);
        const labels: string[] = [];
        for (const base of bases) {
            labels.push(...PREFIXES.map((prefix) => prefix + base), ...SUFFIXES.map((suffix) => base + suffix));
        }

        const tlds = context.tlds.slice(0, 4);
        return combine({ labels: labels.filter(isValidLabel), tlds, source: "affixes" }).slice(0, context.limit);
    },
};

export const shortSuggestor: Suggestor = {
    id: "short",
    label: "Short forms (gentech, gnsis, gnss)",
    online: false,
    defaultOn: true,
    async suggest(context) {
        return combine({ labels: shortForms(context.words), tlds: context.tlds.slice(0, 5), source: "short" }).slice(
            0,
            context.limit
        );
    },
};
