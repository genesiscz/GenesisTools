/**
 * Output-language catalog (Feature 08). `OUTPUT_LANGS` is mirrored in
 * `src/youtube/extension/shared/languages.ts` for the UI Select — keep both
 * lists in sync when adding a language.
 */
export interface OutputLang {
    code: string;
    /** Native label, shown in the UI Select. */
    label: string;
    /** English name of the language, used in the LLM prompt suffix. */
    englishName: string;
}

export const OUTPUT_LANGS: OutputLang[] = [
    { code: "en", label: "English", englishName: "English" },
    { code: "cs", label: "Čeština", englishName: "Czech" },
    { code: "de", label: "Deutsch", englishName: "German" },
    { code: "es", label: "Español", englishName: "Spanish" },
    { code: "fr", label: "Français", englishName: "French" },
];

const OUTPUT_LANG_CODES = new Set(OUTPUT_LANGS.map((entry) => entry.code));

export function isOutputLang(code: string): boolean {
    return OUTPUT_LANG_CODES.has(code);
}

/** English name for a lang code, falling back to the code itself for unknown values. */
export function englishLanguageName(code: string): string {
    return OUTPUT_LANGS.find((entry) => entry.code === code)?.englishName ?? code;
}
