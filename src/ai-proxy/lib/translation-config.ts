import type { CursorTranslationMode } from "@app/ai-proxy/lib/types";

export function resolveTranslationMode({
    configMode,
    flagMode,
    noTranslate,
    headerMode,
}: {
    configMode: CursorTranslationMode;
    flagMode?: CursorTranslationMode;
    noTranslate?: boolean;
    headerMode?: string | null;
}): CursorTranslationMode {
    const normalizedHeader = headerMode?.trim().toLowerCase();

    if (normalizedHeader === "on" || normalizedHeader === "off" || normalizedHeader === "auto") {
        return normalizedHeader;
    }

    if (noTranslate) {
        return "off";
    }

    if (flagMode) {
        return flagMode;
    }

    return configMode;
}
