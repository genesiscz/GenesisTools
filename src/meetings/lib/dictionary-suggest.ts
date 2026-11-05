import type { Correction } from "@genesiscz/utils/meetings/corrections";
import type { DictionaryCandidate } from "@genesiscz/utils/meetings/sources";
import type { DictionaryEntry, ResolvedDictionary } from "@genesiscz/utils/transcribe/dictionary";
import { isEnglishWord } from "@genesiscz/utils/transcribe/terms";

/** A correction confirmed this many times becomes a suggestion. */
export const CORRECTION_REPEATS = 2;

export interface DictionarySuggestion {
    entry: DictionaryEntry;
    /** Why: the source's dictionary, or confirmed corrections. */
    from: string;
}

/** A lower-case word the English word list knows ("up", "app") is ordinary speech, not a term to teach. */
function ordinaryWord(phrase: string): boolean {
    return phrase === phrase.toLowerCase() && !/\s/.test(phrase) && isEnglishWord(phrase);
}

/**
 * Entries to propose for a dictionary level: a source row with a replacement as a `fix`, one without as a `term`,
 * and a correction confirmed at least twice as a `fix`. A value the dictionary already has, or one on the source's
 * ignore list, is left out.
 */
export function suggestDictionary(options: {
    dictionary: ResolvedDictionary;
    sourceId: string;
    sourceWords: DictionaryCandidate[];
    ignore: string[];
    corrections: Correction[];
    project?: string;
}): DictionarySuggestion[] {
    const taken = new Set([
        ...options.dictionary.entries.map((entry) => entry.value.toLowerCase()),
        ...options.ignore.map((value) => value.toLowerCase()),
    ]);
    const suggestions: DictionarySuggestion[] = [];
    const add = (entry: DictionaryEntry, from: string) => {
        const key = entry.value.toLowerCase();

        if (!taken.has(key)) {
            taken.add(key);
            suggestions.push({ entry, from });
        }
    };

    const repeats = new Map<string, { correction: Correction; count: number }>();
    /**
     * One confirmation per meeting item: confirming the same item again is not a second, independent sighting. The
     * ledger is read in order, so an Undo's retraction withdraws the item's confirmation until a later line confirms it.
     */
    const evidence = new Map<string, Correction>();

    for (const correction of options.corrections) {
        // Only a fix confirmed for every line teaches the dictionary; a line-only fix or an older unscoped one does not.
        if (
            correction.kind !== "term" ||
            correction.scope !== "everywhere" ||
            (options.project && correction.project !== options.project)
        ) {
            continue;
        }

        const identity = [correction.meeting, correction.item, correction.heard, correction.fixed]
            .map((part) => `${part.length}:${part}`)
            .join("");

        if (correction.retracted) {
            evidence.delete(identity);
        } else if (!evidence.has(identity)) {
            evidence.set(identity, correction);
        }
    }

    for (const correction of evidence.values()) {
        const key = `${correction.heard}\n${correction.fixed}`;
        const seen = repeats.get(key);
        repeats.set(key, { correction: seen?.correction ?? correction, count: (seen?.count ?? 0) + 1 });
    }

    for (const { correction, count } of repeats.values()) {
        if (count >= CORRECTION_REPEATS) {
            add({ type: "fix", value: correction.heard, substitution: correction.fixed }, `confirmed ${count} times`);
        }
    }

    for (const word of options.sourceWords) {
        if (word.replacement && word.replacement !== word.value) {
            add({ type: "fix", value: word.value, substitution: word.replacement }, options.sourceId);
        } else if (!ordinaryWord(word.value)) {
            add({ type: "term", value: word.replacement ?? word.value }, options.sourceId);
        }
    }

    return suggestions;
}
