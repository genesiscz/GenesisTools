import { CZECH } from "@genesiscz/utils/transcribe/languages/cs";
import { type Download, ensureDownload } from "@genesiscz/utils/transcribe/languages/downloads";
import { DEV_WORDS } from "@genesiscz/utils/transcribe/languages/en";
import { SPELL_PROVIDERS, type SpellEngine, type SpellProviderId } from "@genesiscz/utils/transcribe/languages/spell";
import type { LanguageRules } from "@genesiscz/utils/transcribe/languages/types";
import { createWordCheck, openWordCheck, type WordCheckResult } from "@genesiscz/utils/transcribe/languages/word-check";
import { createHunspellFromFiles } from "hunspell-wasm";

const WORD_RE = /[\p{L}]+/gu;

/**
 * One spoken language of a meeting: how its lines look, and the word check for its words. A new language (English,
 * German) is one class here plus one entry in `WORD_LANGUAGES`.
 */
export abstract class WordLanguage {
    abstract readonly code: string;
    abstract readonly name: string;
    /** Common words this language has and its neighbours do not. */
    protected abstract readonly markerWords: ReadonlySet<string>;
    /** Letters only this language writes. */
    protected abstract readonly markerLetters: RegExp;

    /** How much a text looks like this language: one per marker word, three per marker letter. */
    score(text: string): number {
        const lower = text.toLowerCase();
        const words = lower.match(WORD_RE) ?? [];
        const letters = lower.match(this.markerLetters)?.length ?? 0;

        return words.filter((word) => this.markerWords.has(word)).length + 3 * letters;
    }

    /** The word check for this language's words, or why there is none. The caller disposes it. */
    abstract open(provider: SpellProviderId, words: Iterable<string>): Promise<WordCheckResult>;
}

class CzechLanguage extends WordLanguage {
    readonly code = "cs";
    readonly name = "Czech";
    protected readonly markerWords = new Set(
        "se jsem jsi jsme jste není jako když nebo taky proč teď ještě který která které kterou kterej což protože mě mně vlastně prostě jakoby tady děkuju můžu budu být bylo byla byli hele jasně dobře jenom jestli".split(
            " "
        )
    );
    protected readonly markerLetters = /[řůě]/gu;

    open(provider: SpellProviderId, words: Iterable<string>): Promise<WordCheckResult> {
        return openWordCheck({ language: this.code, provider, words });
    }
}

const WOOORM = "https://raw.githubusercontent.com/wooorm/dictionaries/836d7c2032167880e639a1fe522748733e528c2d";

const DICTIONARY_SK: { aff: Download; dic: Download } = {
    aff: {
        file: "hunspell/dictionary-sk/sk.aff",
        url: `${WOOORM}/dictionaries/sk/index.aff`,
        sha256: "a79dc992b849aa2355db38eea9c4722239993639d77bc81c9c1aa79f213e723c",
        license: "GPL-2.0 OR LGPL-2.1 OR MPL-1.1",
    },
    dic: {
        file: "hunspell/dictionary-sk/sk.dic",
        url: `${WOOORM}/dictionaries/sk/index.dic`,
        sha256: "b6cdb6fb512c44881cc91329aea0b179840f5f9a3e6cb024c2ab8547f96f5d94",
        license: "GPL-2.0 OR LGPL-2.1 OR MPL-1.1",
    },
};

/** Slovak shares the Czech prefixes and loan endings; it has no spoken word list and no spoken-form rules yet. */
const SLOVAK_RULES: LanguageRules = {
    code: "sk",
    loanLanguage: "en",
    writtenForms: () => [],
    prefixedRoots: CZECH.prefixedRoots,
    loanStems: CZECH.loanStems,
};

class SlovakLanguage extends WordLanguage {
    readonly code = "sk";
    readonly name = "Slovak";
    protected readonly markerWords = new Set(
        "sa som sme ste nie ako keď alebo aj tiež prečo teraz ešte ďalej ktorý ktorá ktoré ktorú ktorej ktorí tých tú tej nič nejak nejaký nejakú proste akože hej tuná ďakujem vo zo môžem môžeme môže byť bolo bola boli čo čož lebo pretože podľa mňa".split(
            " "
        )
    );
    protected readonly markerLetters = /[äôľĺŕ]/gu;

    async open(provider: SpellProviderId, words: Iterable<string>): Promise<WordCheckResult> {
        try {
            const engine = await this.engine(provider);
            const loanEngine = await SPELL_PROVIDERS[provider === "macos" ? "macos" : "hunspell"].open("en");
            const check = createWordCheck({
                provider: provider === "macos" ? "macos" : "hunspell",
                language: this.code,
                rules: SLOVAK_RULES,
                engine,
                loanEngine,
                counts: new Map(),
                loanWords: new Set(DEV_WORDS.map((word) => word.toLowerCase())),
                words,
            });

            return { available: true, check };
        } catch (err) {
            return {
                available: false,
                reason: `the Slovak word check failed: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }

    /** The macOS checker when asked for and it has Slovak; otherwise Hunspell with the dictionary-sk files. */
    private async engine(provider: SpellProviderId): Promise<SpellEngine> {
        if (provider === "macos" && !SPELL_PROVIDERS.macos.unavailable(this.code)) {
            return SPELL_PROVIDERS.macos.open(this.code);
        }

        const hunspell = await createHunspellFromFiles(
            await ensureDownload(DICTIONARY_SK.aff),
            await ensureDownload(DICTIONARY_SK.dic)
        );

        return {
            accepted: (list) => new Set(list.filter((word) => word.length > 0 && hunspell.testSpelling(word))),
            dispose: () => hunspell.dispose(),
        };
    }
}

/** Every spoken language the word check tells apart, by code. */
export const WORD_LANGUAGES: Record<string, WordLanguage> = {
    cs: new CzechLanguage(),
    sk: new SlovakLanguage(),
};

/** The language of a line that looks like no language in particular, and of a speaker without a clear one. */
export const DEFAULT_WORD_LANGUAGE = "cs";

/** A line is in a language when its score leads every other language's by this much. */
const LINE_MARGIN = 2;

/** The language that leads a text by `LINE_MARGIN`, if one does. */
export function clearLanguage(text: string): string | undefined {
    const scored = Object.values(WORD_LANGUAGES)
        .map((language) => ({ code: language.code, score: language.score(text) }))
        .sort((a, b) => b.score - a.score);
    const [first, second] = scored;

    return first && first.score - (second?.score ?? 0) >= LINE_MARGIN ? first.code : undefined;
}

/** A speaker speaks a language once this many of their lines are clearly in it. */
const SPEAKER_MIN_LINES = 3;

/**
 * The languages of each line, its main one first: the line's own when the text is clear, else its speaker's most
 * common one, else `DEFAULT_WORD_LANGUAGE`; then every other language its speaker speaks, since a line that mixes
 * Slovak words into Czech ones rarely leads clearly.
 */
export function lineLanguages(lines: Array<{ speaker?: string; text: string }>): string[][] {
    const own = lines.map((line) => clearLanguage(line.text));
    const bySpeaker = new Map<string, Map<string, number>>();

    for (const [index, line] of lines.entries()) {
        const code = own[index];

        if (code && line.speaker !== undefined) {
            const counts = bySpeaker.get(line.speaker) ?? new Map<string, number>();
            counts.set(code, (counts.get(code) ?? 0) + 1);
            bySpeaker.set(line.speaker, counts);
        }
    }

    const spoken = (speaker: string | undefined) =>
        [...((speaker === undefined ? undefined : bySpeaker.get(speaker)) ?? new Map<string, number>()).entries()]
            .filter(([, count]) => count >= SPEAKER_MIN_LINES)
            .sort((a, b) => b[1] - a[1])
            .map(([code]) => code);

    return lines.map((line, index) => {
        const languages = spoken(line.speaker);
        const main = own[index] ?? languages[0] ?? DEFAULT_WORD_LANGUAGE;

        return [main, ...languages.filter((code) => code !== main)];
    });
}
