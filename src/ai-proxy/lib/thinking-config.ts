import type { ThinkingPresentationMode } from "@app/ai-proxy/lib/types";

const THINKING_MODES: ThinkingPresentationMode[] = ["raw", "cursor", "folded"];

export function normalizeThinkingMode(value: string | undefined | null): ThinkingPresentationMode | null {
    if (!value) {
        return null;
    }

    const normalized = value.trim().toLowerCase();

    if (normalized === "raw") {
        return "raw";
    }

    if (normalized === "cursor" || normalized === "blocks" || normalized === "native") {
        return "cursor";
    }

    if (normalized === "folded" || normalized === "details") {
        return "folded";
    }

    return null;
}

export function resolveThinkingMode({
    configMode,
    flagMode,
    headerMode,
}: {
    configMode: ThinkingPresentationMode;
    flagMode?: ThinkingPresentationMode;
    headerMode?: string | null;
}): ThinkingPresentationMode {
    const fromHeader = normalizeThinkingMode(headerMode);
    if (fromHeader) {
        return fromHeader;
    }

    if (flagMode) {
        return flagMode;
    }

    return configMode;
}

export function isValidThinkingMode(value: string): value is ThinkingPresentationMode {
    return THINKING_MODES.includes(value as ThinkingPresentationMode);
}
