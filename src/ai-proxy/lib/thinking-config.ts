import type { ThinkingPresentationMode, ThinkingRule } from "@app/ai-proxy/lib/types";
import { logger } from "@genesiscz/utils/logger";

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

// "auto" on the chat door means "raw": the upstream bytes pass through untouched,
// reasoning_content included, and nothing is ever written into `content` (folded
// does that, and content is what history rewriting later touches). "cursor" is a
// reshape tuned to Cursor's UI (enrichDeltaForCursor) and should only come from a
// rule that actually matched a Cursor client. The /v1/messages door emits native
// thinking blocks and never consults this mode at all.
function resolveRuleMode(mode: ThinkingPresentationMode | "auto"): ThinkingPresentationMode {
    return mode === "auto" ? "raw" : mode;
}

// Compiled once per distinct rule source, not per request — this sits on the
// hot path of every chat completion. Bounded by the config's rule strings; an
// invalid pattern caches as null so it also warns once instead of per request.
const uaRegexCache = new Map<string, RegExp | null>();

function compileUaRegex(source: string): RegExp | null {
    let compiled = uaRegexCache.get(source);

    if (compiled === undefined) {
        try {
            compiled = new RegExp(source, "i");
        } catch (error) {
            logger.warn({ uaRegex: source, error }, "ai-proxy: invalid thinkingRules uaRegex, rule skipped");
            compiled = null;
        }

        uaRegexCache.set(source, compiled);
    }

    return compiled;
}

function matchThinkingRule(rules: ThinkingRule[], userAgent: string): ThinkingPresentationMode | null {
    for (const rule of rules) {
        if (rule.catchAll) {
            return resolveRuleMode(rule.mode);
        }

        if (typeof rule.uaRegex !== "string" || rule.uaRegex.length === 0) {
            continue;
        }

        if (compileUaRegex(rule.uaRegex)?.test(userAgent)) {
            return resolveRuleMode(rule.mode);
        }
    }

    return null;
}

export function resolveThinkingMode({
    configMode,
    flagMode,
    headerMode,
    rules,
    userAgent,
}: {
    configMode: ThinkingPresentationMode;
    flagMode?: ThinkingPresentationMode;
    headerMode?: string | null;
    rules?: ThinkingRule[];
    userAgent?: string | null;
}): ThinkingPresentationMode {
    const fromHeader = normalizeThinkingMode(headerMode);
    if (fromHeader) {
        return fromHeader;
    }

    if (flagMode) {
        return flagMode;
    }

    if (Array.isArray(rules) && rules.length > 0) {
        const fromRule = matchThinkingRule(rules, userAgent ?? "");

        if (fromRule) {
            return fromRule;
        }
    }

    return configMode;
}

export function isValidThinkingMode(value: string): value is ThinkingPresentationMode {
    return THINKING_MODES.includes(value as ThinkingPresentationMode);
}
