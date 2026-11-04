import { type MeetingsConfig, resolveDictionary } from "@genesiscz/utils/meetings/config";
import {
    applyDictionary,
    DEFAULT_FUZZY,
    type DictionaryEntry,
    fuzzyMatches,
    type ResolvedDictionary,
} from "@genesiscz/utils/transcribe/dictionary";

export interface PhraseTest {
    phrase: string;
    /** The phrase after the whole dictionary of the scope, as a transcript line would read. */
    text: string;
    /** The entries that change the phrase on their own, in dictionary order. */
    fired: DictionaryEntry[];
    /** Words close to a term that a transcript would mark for a person to decide, with the score. */
    suggestions: Array<{ heard: string; value: string; score: number }>;
    counts: { fixes: number; spoken: number; fuzzy: number; expansions: number; meanings: number };
}

/**
 * What a project's dictionary (with the global one under it) does to one phrase. Each entry is also tried alone, so
 * the answer names the entries that fired. Reads only.
 */
export function testPhrase(config: MeetingsConfig, options: { phrase: string; project?: string }): PhraseTest {
    const dictionary = resolveDictionary(config, options.project ? { project: options.project } : {});
    const line = [{ speaker: "", text: options.phrase }];
    const applied = applyDictionary(line, dictionary);
    const alone = (entry: DictionaryEntry): ResolvedDictionary => ({ ...dictionary, entries: [entry] });
    const fired = dictionary.entries.filter(
        (entry) => applyDictionary(line, alone(entry)).entries[0]?.text !== options.phrase
    );
    const suggestAt = (dictionary.fuzzy ?? DEFAULT_FUZZY).suggest;

    return {
        phrase: options.phrase,
        text: applied.entries[0]?.text ?? options.phrase,
        fired,
        suggestions: fuzzyMatches(line, dictionary)
            .filter((match) => match.score >= suggestAt)
            .map((match) => ({ heard: match.heard, value: match.value, score: Math.round(match.score * 100) / 100 })),
        counts: {
            fixes: applied.fixes,
            spoken: applied.spoken,
            fuzzy: applied.fuzzy,
            expansions: applied.expansions,
            meanings: applied.meanings,
        },
    };
}
