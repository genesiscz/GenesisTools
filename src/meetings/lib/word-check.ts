import { DEFAULT_SPELL_PROVIDER, SPELL_PROVIDER_IDS } from "@genesiscz/utils/transcribe/languages/spell";
import type { WordCheck, WordVerdict } from "@genesiscz/utils/transcribe/languages/word-check";
import { transcriptWords } from "@genesiscz/utils/transcribe/terms";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { DEFAULT_WORD_LANGUAGE, lineLanguages, WORD_LANGUAGES } from "./word-languages";

/** The word checks `--word-check` offers: each spell provider, or none. */
export const WORD_CHECKS = [...SPELL_PROVIDER_IDS, "off"] as const;
export type WordCheckChoice = (typeof WORD_CHECKS)[number];
export const DEFAULT_WORD_CHECK: WordCheckChoice = DEFAULT_SPELL_PROVIDER;

/**
 * One check over a transcript in several languages: a word is checked in the languages of the lines it occurs in,
 * and is unknown only when every one of them has a check and none knows it. A word heard in lines of a language
 * without a check is never flagged.
 */
class LanguageWordCheck implements WordCheck {
    readonly provider: string;
    readonly language: string;

    constructor(
        private readonly checks: Map<string, WordCheck>,
        private readonly languagesOf: Map<string, Set<string>>
    ) {
        const first = [...checks.values()][0];
        this.provider = first?.provider ?? "none";
        this.language = [...new Set([...languagesOf.values()].flatMap((codes) => [...codes]))].sort().join("+");
    }

    verdict(word: string): WordVerdict {
        const codes = this.languagesOf.get(word.toLowerCase()) ?? new Set([DEFAULT_WORD_LANGUAGE]);
        let unknown: WordVerdict | undefined;

        for (const code of codes) {
            const check = this.checks.get(code);

            if (!check) {
                return { class: "spoken", count: 0, via: `${code}: no word check, not flagged` };
            }

            const verdict = check.verdict(word);

            if (verdict.class !== "unknown") {
                return verdict;
            }

            unknown ??= verdict;
        }

        return unknown ?? { class: "unknown", count: 0 };
    }

    dispose(): void {
        for (const check of this.checks.values()) {
            check.dispose();
        }
    }
}

/**
 * The word check over a transcript's words, or why there is none. Each line is checked in its languages
 * (`lineLanguages`): a Slovak line, or a line of a speaker who speaks Slovak, against the Slovak dictionary too. The
 * caller disposes the check.
 */
export async function wordCheckFor(
    choice: WordCheckChoice,
    transcript: TranscriptEntry[]
): Promise<{ check?: WordCheck; reason?: string }> {
    if (choice === "off") {
        return { reason: "turned off with --word-check off" };
    }

    const codes = lineLanguages(transcript);
    const wordsOf = new Map<string, Set<string>>();
    const languagesOf = new Map<string, Set<string>>();

    for (const [index, entry] of transcript.entries()) {
        for (const word of transcriptWords([entry])) {
            const seen = languagesOf.get(word.toLowerCase()) ?? new Set<string>();

            for (const code of codes[index]!) {
                const words = wordsOf.get(code) ?? new Set<string>();
                words.add(word);
                wordsOf.set(code, words);
                seen.add(code);
            }

            languagesOf.set(word.toLowerCase(), seen);
        }
    }

    wordsOf.set(DEFAULT_WORD_LANGUAGE, wordsOf.get(DEFAULT_WORD_LANGUAGE) ?? new Set());
    const checks = new Map<string, WordCheck>();
    let defaultReason: string | undefined;

    for (const [code, words] of wordsOf) {
        const language = WORD_LANGUAGES[code];
        const opened = language ? await language.open(choice, words) : undefined;

        if (opened?.available) {
            checks.set(code, opened.check);
        } else if (code === DEFAULT_WORD_LANGUAGE) {
            defaultReason = opened?.reason ?? `no word language "${code}"`;
        }
    }

    if (defaultReason) {
        for (const check of checks.values()) {
            check.dispose();
        }

        return { reason: defaultReason };
    }

    return { check: new LanguageWordCheck(checks, languagesOf) };
}
