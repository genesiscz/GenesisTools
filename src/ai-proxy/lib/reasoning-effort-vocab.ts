import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

/**
 * Per-provider `reasoning_effort` vocabulary clamps.
 *
 * The proxy's suffix vocabulary (minimal|low|medium|high|xhigh|max) is wider
 * than what either upstream accepts, and xAI hard-400s the PARAMETER itself on
 * most models — so an unmapped stamp turned every suffixed request into a
 * failure. Researched against official docs 2026-08-20:
 * - https://docs.x.ai/docs/guides/reasoning — grok-4.6 takes low|medium|high|xhigh,
 *   grok-4.5 takes low|medium|high (xhigh self-downgrades to high upstream),
 *   grok-4.20 takes the four values (they select agent count there); legacy
 *   grok-3-mini takes low|high. Models outside these families reject the field
 *   with HTTP 400 "does not support parameter reasoningEffort" (reproduced in
 *   NousResearch/hermes-agent#23088 and charmbracelet/crush#2078).
 * - https://openrouter.ai/docs/api_reference/parameters — the top-level
 *   `reasoning_effort` enum is xhigh|high|medium|low|minimal|none, WITHOUT max;
 *   the reasoning-tokens guide prices max and xhigh identically (~95% of
 *   max_tokens), and OpenRouter normalizes enum values per model itself.
 */

const XAI_EFFORT_ORDER = ["low", "medium", "high", "xhigh"] as const;

/** Proxy-only vocabulary mapped onto xAI's ladder before clamping. */
const PROXY_TO_XAI: Record<string, string> = { minimal: "low", max: "xhigh" };

const XAI_EFFORT_MODELS: Array<{ test: RegExp; allowed: readonly string[] }> = [
    { test: /^grok-4\.6/, allowed: XAI_EFFORT_ORDER },
    { test: /^grok-4\.20/, allowed: XAI_EFFORT_ORDER },
    { test: /^grok-4\.5/, allowed: ["low", "medium", "high"] },
    { test: /^grok-3-mini/, allowed: ["low", "high"] },
];

/** Lowest allowed effort at or above the request, else the strongest allowed — the ask never rounds to weaker than it must. */
function nearestAllowed(requested: string, allowed: readonly string[]): string {
    const want = XAI_EFFORT_ORDER.indexOf(requested as (typeof XAI_EFFORT_ORDER)[number]);

    for (const value of XAI_EFFORT_ORDER) {
        if (XAI_EFFORT_ORDER.indexOf(value) >= want && allowed.includes(value)) {
            return value;
        }
    }

    return allowed[allowed.length - 1];
}

function clampForXai(value: unknown, upstreamModel: string): { drop: boolean; value?: string } {
    if (typeof value !== "string") {
        return { drop: false };
    }

    const family = XAI_EFFORT_MODELS.find((rule) => rule.test.test(upstreamModel));

    if (!family) {
        // Not a known effort-taking family: the field itself is a hard 400
        // there, so the stamp is dropped rather than failing every request.
        // A new grok family that gains the parameter needs a row above.
        return { drop: true };
    }

    const requested = PROXY_TO_XAI[value] ?? value;

    if (!XAI_EFFORT_ORDER.includes(requested as (typeof XAI_EFFORT_ORDER)[number])) {
        // Not proxy vocabulary — the client's own explicit value. Forwarded
        // verbatim so a wrong value fails loudly as the client wrote it.
        return { drop: false };
    }

    const clamped = nearestAllowed(requested, family.allowed);
    return { drop: false, value: clamped };
}

/**
 * Map/strip `reasoning_effort` (and nested `reasoning.effort`) for xAI, whose
 * accepted values differ per model family and whose other models reject the
 * parameter outright.
 */
export function clampXaiReasoningEffort(bodyText: string, upstreamModel: string): string {
    try {
        const parsed = SafeJSON.parse(bodyText, { strict: true });

        if (!isObject(parsed)) {
            return bodyText;
        }

        const next = { ...parsed };
        let changed = false;

        const top = clampForXai(next.reasoning_effort, upstreamModel);

        if (top.drop && next.reasoning_effort !== undefined) {
            delete next.reasoning_effort;
            changed = true;
        } else if (top.value !== undefined && top.value !== next.reasoning_effort) {
            next.reasoning_effort = top.value;
            changed = true;
        }

        if (isObject(next.reasoning)) {
            const nested = clampForXai(next.reasoning.effort, upstreamModel);

            if (nested.drop && next.reasoning.effort !== undefined) {
                const { effort: _dropped, ...rest } = next.reasoning;
                next.reasoning = rest;
                changed = true;
            } else if (nested.value !== undefined && nested.value !== next.reasoning.effort) {
                next.reasoning = { ...next.reasoning, effort: nested.value };
                changed = true;
            }
        }

        if (!changed) {
            return bodyText;
        }

        logger.debug(
            { upstreamModel, effort: parsed.reasoning_effort },
            "ai-proxy: clamped reasoning effort to xAI's vocabulary for this model"
        );
        return SafeJSON.stringify(next);
    } catch (err) {
        logger.debug({ err, upstreamModel }, "ai-proxy: xAI effort clamp skipped — body was not parseable JSON");
        return bodyText;
    }
}

/**
 * OpenRouter's top-level `reasoning_effort` enum has no `max`; its docs give
 * max and xhigh the same token allocation, so `max` maps to `xhigh` instead of
 * 400ing. Every other proxy value is in OpenRouter's enum, and OpenRouter
 * normalizes per model on its own.
 */
export function mapOpenRouterReasoningEffort(bodyText: string): string {
    try {
        const parsed = SafeJSON.parse(bodyText, { strict: true });

        if (!isObject(parsed) || parsed.reasoning_effort !== "max") {
            return bodyText;
        }

        logger.debug("ai-proxy: mapped reasoning_effort max → xhigh for OpenRouter's top-level enum");
        return SafeJSON.stringify({ ...parsed, reasoning_effort: "xhigh" });
    } catch (err) {
        logger.debug({ err }, "ai-proxy: OpenRouter effort map skipped — body was not parseable JSON");
        return bodyText;
    }
}
