import { similarityScore } from "@genesiscz/utils/fuzzy-match";
import { z } from "zod";
import { MIN_STEM, stemOf } from "./languages/cs";
import type { TranscriptEntry } from "./types";

/** How an abbreviation is expanded: at every mention, at its first mention in the transcript, or not at all. */
export const ABBR_EXPANSIONS = ["every", "first", "off"] as const;
export type AbbrExpansion = (typeof ABBR_EXPANSIONS)[number];
export const DEFAULT_ABBR_EXPANSION: AbbrExpansion = "every";

const value = z.string().trim().min(1);

/**
 * One dictionary entry:
 * - `fix`: a misheard spelling; every whole-word match becomes `substitution`.
 * - `abbr`: an abbreviation; expanded as `abbrExpansion` says. Its substitution must contain the value itself
 *   ("MOP" becomes "MOP (Obchodní partner podnikatel)"), so the original is never lost.
 * - `term`: a correct spelling the misheard-term check should know; `spoken` lists how people say it.
 * - `keep`: a word the misheard-term check must never flag in this scope.
 */
export const dictionaryEntrySchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("fix"), value, substitution: value }),
    z.object({ type: z.literal("abbr"), value, substitution: value }),
    z.object({
        type: z.literal("term"),
        value,
        /** How people say it ("jenezetka" for JDZ): a whole-word spoken form is replaced by the value. */
        spoken: z.array(value).optional(),
        /** What it means, shown after its first mention in Markdown. */
        meaning: value.optional(),
    }),
    z.object({ type: z.literal("keep"), value }),
]);
export type DictionaryEntry = z.infer<typeof dictionaryEntrySchema>;

/** A pattern that matches only as whole words. JavaScript's `\b` treats "í" or "ž" as a word edge, so it cannot. */
function wholeWord(text: string, flags = "gu"): RegExp {
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, flags);
}

/** One level of the dictionary: global, a project, or one meeting. */
export const dictionaryLevelSchema = z
    .object({
        abbrExpansion: z.enum(ABBR_EXPANSIONS).optional(),
        /**
         * Fuzzy matching against terms and their spoken forms, 0 to 1: at `apply` or above a word is replaced; from
         * `suggest` up to `apply` it becomes a suggestion with its score; below `suggest` nothing happens.
         */
        fuzzy: z
            .object({ apply: z.number().min(0).max(1), suggest: z.number().min(0).max(1) })
            .partial()
            .optional(),
        entries: z.array(dictionaryEntrySchema).default([]),
    })
    .superRefine((level, ctx) => {
        level.entries.forEach((entry, index) => {
            if (entry.type !== "abbr" || wholeWord(entry.value, "u").test(entry.substitution)) {
                return;
            }

            ctx.addIssue({
                code: "custom",
                path: ["entries", index, "substitution"],
                message:
                    `abbr "${entry.value}": the substitution must contain "${entry.value}" itself, ` +
                    `for example "${entry.value} (${entry.substitution})"`,
            });
        });
    });
export type DictionaryLevel = z.infer<typeof dictionaryLevelSchema>;

export const DEFAULT_FUZZY = { apply: 0.95, suggest: 0.8 } as const;

export interface ResolvedDictionary {
    fuzzy?: { apply: number; suggest: number };
    abbrExpansion: AbbrExpansion;
    entries: DictionaryEntry[];
}

/**
 * Merges the levels in order (global, project, meeting). A later level wins: its `abbrExpansion` when it sets one,
 * and its entry for a value an earlier level also has.
 */
export function mergeDictionaries(levels: Array<DictionaryLevel | undefined>): ResolvedDictionary {
    let abbrExpansion = DEFAULT_ABBR_EXPANSION;
    let fuzzy: { apply: number; suggest: number } = { ...DEFAULT_FUZZY };
    const byValue = new Map<string, DictionaryEntry>();

    for (const level of levels) {
        if (!level) {
            continue;
        }

        abbrExpansion = level.abbrExpansion ?? abbrExpansion;
        fuzzy = { ...fuzzy, ...level.fuzzy };

        for (const entry of level.entries) {
            byValue.delete(entry.value);
            byValue.set(entry.value, entry);
        }
    }

    return { abbrExpansion, fuzzy, entries: [...byValue.values()] };
}

/** A word that sounds like a term or one of its spoken forms. */
export interface FuzzyMatch {
    line: number;
    heard: string;
    value: string;
    score: number;
}

function termForms(dictionary: ResolvedDictionary): Array<{ value: string; form: string; stem: string }> {
    return dictionary.entries.flatMap((entry) => {
        if (entry.type !== "term") {
            return [];
        }

        return [entry.value, ...(entry.spoken ?? [])]
            .filter((form) => !/\s/.test(form))
            .map((form) => ({ value: entry.value, form, stem: stemOf(form) }))
            .filter((form) => form.stem.length >= MIN_STEM);
    });
}

/**
 * Single words that are not a term or a spoken form but come close to one, after the Czech ending is stripped
 * (normalised edit distance on the stem). Only matches at `fuzzy.suggest` or above are returned.
 */
export function fuzzyMatches(entries: TranscriptEntry[], dictionary: ResolvedDictionary): FuzzyMatch[] {
    const threshold = (dictionary.fuzzy ?? DEFAULT_FUZZY).suggest;
    const forms = termForms(dictionary);
    const exact = new Set(forms.map((form) => form.form.toLowerCase()));
    const matches: FuzzyMatch[] = [];

    entries.forEach((entry, line) => {
        for (const word of entry.text.match(/[\p{L}\p{N}]+/gu) ?? []) {
            const stem = stemOf(word);

            if (stem.length < MIN_STEM || exact.has(word.toLowerCase())) {
                continue;
            }

            let best: FuzzyMatch | undefined;

            for (const form of forms) {
                if (Math.min(stem.length, form.stem.length) / Math.max(stem.length, form.stem.length) < 0.7) {
                    continue;
                }

                const score = similarityScore(stem, form.stem);

                if (score >= threshold && (!best || score > best.score)) {
                    best = { line, heard: word, value: form.value, score };
                }
            }

            if (best) {
                matches.push(best);
            }
        }
    });

    return matches;
}

export interface DictionaryApplied {
    entries: TranscriptEntry[];
    /** Replacements made by `fix` entries. */
    fixes: number;
    /** Spoken forms replaced by their term. */
    spoken: number;
    /** Words replaced by a fuzzy match at or above `fuzzy.apply`. */
    fuzzy: number;
    /** Abbreviations expanded. */
    expansions: number;
    /** Term meanings written after a first mention. */
    meanings: number;
}

/** How an expansion or a meaning is written: in parentheses (text, subtitles) or as a superscript (Markdown). */
export const DICTIONARY_NOTES = ["inline", "sup"] as const;
export type DictionaryNotes = (typeof DICTIONARY_NOTES)[number];

/**
 * An abbreviation's substitution as written in the output. The stored form stays "MOP (Obchodní partner podnikatel)";
 * `sup` splits it at the value into "MOP <sup>(Obchodní partner podnikatel)</sup>".
 */
function writtenExpansion(abbr: { value: string; substitution: string }, notes: DictionaryNotes): string {
    const at = abbr.substitution.indexOf(abbr.value);
    const after = abbr.substitution.slice(at + abbr.value.length).trim();

    if (notes === "inline" || at < 0 || !after) {
        return abbr.substitution;
    }

    return `${abbr.substitution.slice(0, at)}${abbr.value} <sup>${after}</sup>`;
}

/**
 * Applies `fix` and `abbr` entries to every line, in transcript order. Fixes run first, so an abbreviation that a fix
 * produced is expanded too. A mention already written as its expansion ("MOP (Obchodní …)") is left alone. A term's
 * `meaning` follows its first mention. `notes` says how expansions and meanings are written (default `inline`).
 */
export function applyDictionary(
    entries: TranscriptEntry[],
    dictionary: ResolvedDictionary,
    options: { notes?: DictionaryNotes } = {}
): DictionaryApplied {
    const notes = options.notes ?? "inline";
    const meanings = dictionary.entries.flatMap((entry) =>
        entry.type === "term" && entry.meaning ? [{ value: entry.value, meaning: entry.meaning }] : []
    );
    const meant = new Set<string>();
    let meaningCount = 0;
    const fixes = dictionary.entries.filter((entry) => entry.type === "fix");
    const abbrs = dictionary.abbrExpansion === "off" ? [] : dictionary.entries.filter((entry) => entry.type === "abbr");
    const spokenForms = dictionary.entries.flatMap((entry) =>
        entry.type === "term" ? (entry.spoken ?? []).map((form) => ({ form, value: entry.value })) : []
    );
    const applyAt = (dictionary.fuzzy ?? DEFAULT_FUZZY).apply;
    const sure = new Map<number, FuzzyMatch[]>();

    for (const match of fuzzyMatches(entries, dictionary).filter((candidate) => candidate.score >= applyAt)) {
        sure.set(match.line, [...(sure.get(match.line) ?? []), match]);
    }

    const expanded = new Set<string>();
    let fixCount = 0;
    let spokenCount = 0;
    let fuzzyCount = 0;
    let expansionCount = 0;

    const result = entries.map((line, index) => {
        let text = line.text;

        for (const fix of fixes) {
            text = text.replace(wholeWord(fix.value), () => {
                fixCount += 1;
                return fix.substitution;
            });
        }

        for (const spoken of spokenForms) {
            text = text.replace(wholeWord(spoken.form, "giu"), () => {
                spokenCount += 1;
                return spoken.value;
            });
        }

        for (const match of sure.get(index) ?? []) {
            text = text.replace(wholeWord(match.heard), () => {
                fuzzyCount += 1;
                return match.value;
            });
        }

        for (const abbr of abbrs) {
            text = text.replace(wholeWord(abbr.value), (match, offset: number, whole: string) => {
                const expansionStart = offset - abbr.substitution.indexOf(abbr.value);

                if (expansionStart >= 0 && whole.startsWith(abbr.substitution, expansionStart)) {
                    expanded.add(abbr.value);
                    return match;
                }

                if (dictionary.abbrExpansion === "first" && expanded.has(abbr.value)) {
                    return match;
                }

                expanded.add(abbr.value);
                expansionCount += 1;
                return writtenExpansion(abbr, notes);
            });
        }

        for (const term of meanings) {
            if (meant.has(term.value)) {
                continue;
            }

            const written = `(${term.meaning})`;
            text = text.replace(wholeWord(term.value, "u"), (match, offset: number, whole: string) => {
                meant.add(term.value);
                const next = whole.slice(offset + match.length).trimStart();

                if (next.startsWith(written) || next.startsWith(`<sup>${written}`)) {
                    return match;
                }

                meaningCount += 1;
                return notes === "sup" ? `${match} <sup>${written}</sup>` : `${match} ${written}`;
            });
        }

        return text === line.text ? line : { ...line, text };
    });

    return {
        entries: result,
        fixes: fixCount,
        spoken: spokenCount,
        fuzzy: fuzzyCount,
        expansions: expansionCount,
        meanings: meaningCount,
    };
}
