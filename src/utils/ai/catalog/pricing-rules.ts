import type { ModelPricing, PricingRule } from "./types";

export interface PricingContext {
    /** When the call happens. Omit and dated rules simply do not apply. */
    at?: Date;
    /** Recorded service tier; absence does not imply Fast mode. */
    serviceTier?: string;
    /** The request's token count. Omit and context-banded rules do not apply. */
    contextTokens?: number;
}

/** ISO dates compare correctly as strings, and UTC keeps the boundary reproducible. */
function utcDay(at: Date): string {
    return at.toISOString().slice(0, 10);
}

/**
 * An absent condition is open-ended; an absent INPUT fails the condition.
 *
 * That asymmetry is deliberate. A caller who does not say when the call happens
 * cannot have a dated discount applied on their behalf, and one who does not say
 * how long the prompt is cannot be charged a long-context surcharge. Both
 * unknowns therefore fall back to the base rate rather than guessing, and the
 * guess that would have been convenient (assume "now") is also the one that
 * makes this function untestable.
 */
function ruleApplies(rule: PricingRule, context: PricingContext): boolean {
    const tier = (value: string | undefined) => (value === "fast" ? "priority" : value);
    if (rule.serviceTier !== undefined && tier(rule.serviceTier) !== tier(context.serviceTier)) {
        return false;
    }

    const dated = rule.from !== undefined || rule.to !== undefined;

    if (dated) {
        if (!context.at) {
            return false;
        }

        const day = utcDay(context.at);

        if ((rule.from !== undefined && day < rule.from) || (rule.to !== undefined && day > rule.to)) {
            return false;
        }
    }

    const banded = rule.ctxFrom !== undefined || rule.ctxTo !== undefined;

    if (banded) {
        const tokens = context.contextTokens;

        if (tokens === undefined) {
            return false;
        }

        if (
            (rule.ctxFrom !== undefined && tokens < rule.ctxFrom) ||
            (rule.ctxTo !== undefined && tokens > rule.ctxTo)
        ) {
            return false;
        }
    }

    return true;
}

/**
 * Resolve conditional rates into the one price that applies.
 *
 * Pure: same arguments, same answer, no clock and no I/O. Matching rules are
 * applied in array order and a later match wins field by field, so a promo rule
 * placed after a context tier overrides only the fields it names.
 *
 * The result carries no `rules` — it is the resolved price, and dropping them
 * makes re-applying it to itself impossible rather than merely wrong.
 */
export function effectivePricing(pricing: ModelPricing, context: PricingContext = {}): ModelPricing {
    const { rules, ...base } = pricing;

    if (!rules || rules.length === 0) {
        return base;
    }

    const resolved: ModelPricing = { ...base };

    for (const rule of rules) {
        if (!ruleApplies(rule, context)) {
            continue;
        }

        for (const field of [
            "inputPer1M",
            "outputPer1M",
            "cachedReadPer1M",
            "cachedCreatePer1M",
            "cachedCreate1hPer1M",
        ] as const) {
            const override = rule[field];

            if (override !== undefined) {
                resolved[field] = override;
            }
        }
    }

    return resolved;
}
