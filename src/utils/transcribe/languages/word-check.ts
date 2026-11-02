import { CZECH } from "./cs";
import { ensureDownload } from "./downloads";
import { DEV_WORDS } from "./en";
import {
    DEFAULT_SPELL_PROVIDER,
    SPELL_PROVIDERS,
    type SpellEngine,
    type SpellProvider,
    type SpellProviderId,
} from "./spell";
import type { LanguageRules } from "./types";

/** Every language the word check knows. A new one is a file in this folder plus a line here. */
export const LANGUAGES: Record<string, LanguageRules> = { cs: CZECH };
/** Words of a loan language that its dictionary lacks. */
const LOAN_WORDS: Record<string, readonly string[]> = { en: DEV_WORDS };

/**
 * How the word check classed a word. `dictionary`: the spell checker knows it. `spoken`: people say it (the
 * spoken word list, or a written form the dictionary knows). `derived`: a prefix on a known word ("vysdílím").
 * `loan`: an English word, bare or with a Czech prefix and ending. `code`: a name or number from a screen
 * ("data.tile", "40px"). `fragment`: a word cut off mid-way ("teoreti-"). `unknown`: no layer accepts it.
 */
export type WordClass = "dictionary" | "spoken" | "derived" | "loan" | "code" | "fragment" | "unknown";

export interface WordVerdict {
    class: WordClass;
    /** Occurrences in the spoken word list; 0 below SPOKEN_MIN or without a list. */
    count: number;
    /** The written form a spoken word stands for, or the English stem of a loan word. */
    via?: string;
}

export interface WordCheck {
    readonly provider: string;
    readonly language: string;
    verdict(word: string): WordVerdict;
    dispose(): void;
}

export type WordCheckResult = { available: true; check: WordCheck } | { available: false; reason: string };

/** A word said this often in the subtitles is speech, even when no dictionary has it ("jakej" 6,586, "nepeníze" 2). */
export const SPOKEN_MIN = 5;

const wordLists = new Map<string, Map<string, number>>();

/** The counts at or above SPOKEN_MIN, by lower-case word. */
async function wordCounts(rules: LanguageRules): Promise<Map<string, number>> {
    if (!rules.wordList) {
        return new Map();
    }

    const cached = wordLists.get(rules.code);

    if (cached) {
        return cached;
    }

    const text = await Bun.file(await ensureDownload(rules.wordList)).text();
    const counts = new Map<string, number>();
    let start = 0;

    while (start < text.length) {
        const newline = text.indexOf("\n", start);
        const end = newline < 0 ? text.length : newline;
        const space = text.lastIndexOf(" ", end);

        if (space > start) {
            const count = Number(text.slice(space + 1, end));

            if (count >= SPOKEN_MIN) {
                counts.set(text.slice(start, space), count);
            }
        }

        start = end + 1;
    }

    wordLists.set(rules.code, counts);

    return counts;
}

export interface WordCheckParts {
    provider: string;
    language: string;
    rules: LanguageRules;
    engine: SpellEngine;
    loanEngine?: SpellEngine;
    counts: Map<string, number>;
    /** Lower-case loan words no engine knows: developer words and the meeting's own terms. */
    loanWords: Set<string>;
}

class LayeredWordCheck implements WordCheck {
    readonly provider: string;
    readonly language: string;
    private readonly rules: LanguageRules;
    private readonly engine: SpellEngine;
    private readonly loanEngine?: SpellEngine;
    private readonly counts: Map<string, number>;
    private readonly loanWords: Set<string>;
    private readonly verdicts = new Map<string, WordVerdict>();
    private readonly known = new Map<string, boolean>();
    private readonly loanKnown = new Map<string, boolean>();

    constructor(parts: WordCheckParts) {
        this.provider = parts.provider;
        this.language = parts.language;
        this.rules = parts.rules;
        this.engine = parts.engine;
        this.loanEngine = parts.loanEngine;
        this.counts = parts.counts;
        this.loanWords = parts.loanWords;
    }

    /** One spell checker call for every form of `words`, so a batch engine (macos) is not called per word. */
    prime(words: Iterable<string>): void {
        const forms = new Set<string>();
        const stems = new Set<string>();

        for (const word of words) {
            forms.add(word);

            for (const form of this.rules.writtenForms(word)) {
                forms.add(form);
            }

            for (const root of this.rules.prefixedRoots(word)) {
                forms.add(root);

                for (const form of this.rules.writtenForms(root)) {
                    forms.add(form);
                }
            }

            stems.add(word);

            for (const stem of this.rules.loanStems(word)) {
                stems.add(stem);
            }
        }

        ask(this.engine, this.known, forms);

        if (this.loanEngine) {
            ask(this.loanEngine, this.loanKnown, stems);
        }
    }

    verdict(word: string): WordVerdict {
        const cached = this.verdicts.get(word);

        if (cached) {
            return cached;
        }

        const verdict = this.classify(word);
        this.verdicts.set(word, verdict);

        return verdict;
    }

    private classify(word: string): WordVerdict {
        const count = this.counts.get(word.toLowerCase()) ?? 0;

        if (word.endsWith("-")) {
            return { class: "fragment", count };
        }

        if (/[\d_/]|\p{L}\.\p{L}/u.test(word)) {
            return { class: "code", count };
        }

        if (accepts(this.engine, this.known, word)) {
            return { class: "dictionary", count };
        }

        if (count > 0) {
            return { class: "spoken", count };
        }

        const written = this.rules
            .writtenForms(word)
            .find((form) => accepts(this.engine, this.known, form) || this.counts.has(form));

        if (written) {
            return { class: "spoken", count, via: written };
        }

        const root = this.rules
            .prefixedRoots(word)
            .find(
                (candidate) =>
                    accepts(this.engine, this.known, candidate) ||
                    this.counts.has(candidate) ||
                    this.rules.writtenForms(candidate).some((form) => accepts(this.engine, this.known, form))
            );

        if (root) {
            return { class: "derived", count, via: root };
        }

        const loanEngine = this.loanEngine;

        if (loanEngine) {
            const stem = [word, ...this.rules.loanStems(word)].find(
                (candidate) =>
                    this.loanWords.has(candidate.toLowerCase()) || accepts(loanEngine, this.loanKnown, candidate)
            );

            if (stem) {
                return { class: "loan", count, via: stem };
            }
        }

        return { class: "unknown", count };
    }

    dispose(): void {
        this.engine.dispose();
        this.loanEngine?.dispose();
    }
}

function ask(engine: SpellEngine, cache: Map<string, boolean>, words: Iterable<string>): void {
    const fresh = [...words].filter((word) => !cache.has(word));

    if (fresh.length === 0) {
        return;
    }

    const accepted = engine.accepted(fresh);

    for (const word of fresh) {
        cache.set(word, accepted.has(word));
    }
}

function accepts(engine: SpellEngine, cache: Map<string, boolean>, word: string): boolean {
    ask(engine, cache, [word]);

    return cache.get(word) ?? false;
}

/** A word check over engines that are already open; `words` are checked in one batch. */
export function createWordCheck(parts: WordCheckParts & { words?: Iterable<string> }): WordCheck {
    const check = new LayeredWordCheck(parts);

    if (parts.words) {
        check.prime(parts.words);
    }

    return check;
}

/**
 * The word check for `language`: the provider's dictionary, then the spoken word list and the spoken-form rules,
 * then English stems for loan words. Not available on a system or for a language the provider lacks, or when a
 * download fails; the reason says which, so the caller can run without it. `words` are checked in one batch;
 * `terms` (the meeting's vocabulary) count as loan words.
 */
export async function openWordCheck(options: {
    language?: string;
    provider?: SpellProviderId;
    words?: Iterable<string>;
    terms?: Iterable<string>;
}): Promise<WordCheckResult> {
    const language = options.language ?? "cs";
    const rules = LANGUAGES[language];
    const provider: SpellProvider = SPELL_PROVIDERS[options.provider ?? DEFAULT_SPELL_PROVIDER];

    if (!rules) {
        return { available: false, reason: `the word check has no rules for "${language}"` };
    }

    const reason = provider.unavailable(language) ?? (rules.loanLanguage && provider.unavailable(rules.loanLanguage));

    if (reason) {
        return { available: false, reason };
    }

    try {
        const engine = await provider.open(language);
        const loanEngine = rules.loanLanguage ? await provider.open(rules.loanLanguage) : undefined;
        const loanWords = new Set(
            [...(LOAN_WORDS[rules.loanLanguage ?? ""] ?? []), ...(options.terms ?? [])].map((word) =>
                word.toLowerCase()
            )
        );
        const check = createWordCheck({
            provider: provider.id,
            language,
            rules,
            engine,
            loanEngine,
            counts: await wordCounts(rules),
            loanWords,
            words: options.words,
        });

        return { available: true, check };
    } catch (err) {
        return {
            available: false,
            reason: `${provider.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
