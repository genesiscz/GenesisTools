/**
 * Output-language catalog (Feature 08), client side. Re-exports the single
 * source of truth in `src/youtube/lib/languages.ts` so the UI Select and the
 * server-side validation never drift. Shared by every consumer of
 * `src/utils/ui/components/youtube/*` (extension side panel, dashboard).
 */
export { OUTPUT_LANGS, type OutputLang } from "@app/youtube/lib/languages";

import { OUTPUT_LANGS } from "@app/youtube/lib/languages";

export function outputLangLabel(code: string): string {
    return OUTPUT_LANGS.find((entry) => entry.code === code)?.label ?? code.toUpperCase();
}
