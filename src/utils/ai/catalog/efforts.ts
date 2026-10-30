/**
 * Every reasoning-effort value a provider takes, weakest first: the union of Anthropic's (`low` to `max`), OpenAI's
 * and OpenRouter's (`none`, `minimal` to `xhigh`) and the proxy's own `ultra`. A provider takes a subset, so a list
 * for one provider is `effortRange(from, to)` or a filter of this list, never a list of its own
 * (lint-rules `no-effort-vocabulary-list`).
 */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

type Between<
    List extends readonly string[],
    From extends string,
    To extends string,
    Started extends boolean = false,
> = List extends readonly [infer Head extends string, ...infer Rest extends readonly string[]]
    ? Started extends true
        ? Head extends To
            ? Head
            : Head | Between<Rest, From, To, true>
        : Head extends From
          ? Head extends To
              ? Head
              : Head | Between<Rest, From, To, true>
          : Between<Rest, From, To, false>
    : never;

/**
 * The efforts from `From` to `To` as a type, both included, so a provider's subset is written once as a range and
 * never as a union literal of its own: `type ReviewEffort = EffortRange<"low", "max">` is
 * `"low" | "medium" | "high" | "xhigh" | "max"`. The runtime twin is `effortRange(from, to)`.
 */
export type EffortRange<From extends ReasoningEffort, To extends ReasoningEffort> = Between<
    typeof REASONING_EFFORTS,
    From,
    To
>;

/** The efforts from `from` to `to`, both included, weakest first: `effortRange("low", "max")`. */
export function effortRange<From extends ReasoningEffort, To extends ReasoningEffort>(
    from: From,
    to: To
): EffortRange<From, To>[] {
    const first = REASONING_EFFORTS.indexOf(from);
    const last = REASONING_EFFORTS.indexOf(to);

    return REASONING_EFFORTS.filter(
        (_effort, index): _effort is EffortRange<From, To> => index >= first && index <= last
    );
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
    return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}
