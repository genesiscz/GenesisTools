/**
 * Every reasoning-effort value a provider takes, weakest first: the union of Anthropic's (`low` to `max`), OpenAI's
 * and OpenRouter's (`none`, `minimal` to `xhigh`) and the proxy's own `ultra`. A provider takes a subset, so a list
 * for one provider is `effortRange(from, to)` or a filter of this list, never a list of its own
 * (lint-rules `no-effort-vocabulary-list`).
 */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** The efforts from `from` to `to`, both included, weakest first: `effortRange("low", "max")`. */
export function effortRange<From extends ReasoningEffort, To extends ReasoningEffort>(
    from: From,
    to: To
): ReasoningEffort[] {
    return REASONING_EFFORTS.slice(REASONING_EFFORTS.indexOf(from), REASONING_EFFORTS.indexOf(to) + 1);
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
    return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}
