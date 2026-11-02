import { z } from "zod";
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
    z.object({ type: z.literal("term"), value, spoken: z.array(value).optional() }),
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

export interface ResolvedDictionary {
    abbrExpansion: AbbrExpansion;
    entries: DictionaryEntry[];
}

/**
 * Merges the levels in order (global, project, meeting). A later level wins: its `abbrExpansion` when it sets one,
 * and its entry for a value an earlier level also has.
 */
export function mergeDictionaries(levels: Array<DictionaryLevel | undefined>): ResolvedDictionary {
    let abbrExpansion = DEFAULT_ABBR_EXPANSION;
    const byValue = new Map<string, DictionaryEntry>();

    for (const level of levels) {
        if (!level) {
            continue;
        }

        abbrExpansion = level.abbrExpansion ?? abbrExpansion;

        for (const entry of level.entries) {
            byValue.delete(entry.value);
            byValue.set(entry.value, entry);
        }
    }

    return { abbrExpansion, entries: [...byValue.values()] };
}

export interface DictionaryApplied {
    entries: TranscriptEntry[];
    /** Replacements made by `fix` entries. */
    fixes: number;
    /** Abbreviations expanded. */
    expansions: number;
}

/**
 * Applies `fix` and `abbr` entries to every line, in transcript order. Fixes run first, so an abbreviation that a fix
 * produced is expanded too. A mention already written as its expansion ("MOP (Obchodní …)") is left alone.
 */
export function applyDictionary(entries: TranscriptEntry[], dictionary: ResolvedDictionary): DictionaryApplied {
    const fixes = dictionary.entries.filter((entry) => entry.type === "fix");
    const abbrs = dictionary.abbrExpansion === "off" ? [] : dictionary.entries.filter((entry) => entry.type === "abbr");
    const expanded = new Set<string>();
    let fixCount = 0;
    let expansionCount = 0;

    const result = entries.map((line) => {
        let text = line.text;

        for (const fix of fixes) {
            text = text.replace(wholeWord(fix.value), () => {
                fixCount += 1;
                return fix.substitution;
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
                return abbr.substitution;
            });
        }

        return text === line.text ? line : { ...line, text };
    });

    return { entries: result, fixes: fixCount, expansions: expansionCount };
}
