/**
 * Output-language catalog (Feature 08), client side. Mirrors
 * `src/youtube/lib/languages.ts` (the server-side validation copy) — keep
 * both lists in sync when adding a language. Shared by every consumer of
 * `src/utils/ui/components/youtube/*` (extension side panel, dashboard).
 */
export interface OutputLang {
    code: string;
    /** Native label, shown in the UI Select. */
    label: string;
}

export const OUTPUT_LANGS: OutputLang[] = [
    { code: "en", label: "English" },
    { code: "cs", label: "Čeština" },
    { code: "de", label: "Deutsch" },
    { code: "es", label: "Español" },
    { code: "fr", label: "Français" },
];

export function outputLangLabel(code: string): string {
    return OUTPUT_LANGS.find((entry) => entry.code === code)?.label ?? code.toUpperCase();
}
