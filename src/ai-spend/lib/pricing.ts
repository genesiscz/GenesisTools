import type { ModelPrice, PricingTable, TokenTotals } from "./types";

/**
 * $/Mtok. cacheWrite ≈ 1.25× input, cacheRead ≈ 0.1× input (Anthropic public ratios).
 * Keys are model-id prefixes; priceFor() resolves by longest matching prefix so
 * versioned ids (claude-opus-4-8-20260101) hit the family entry.
 */
export const DEFAULT_PRICING: PricingTable = {
    "claude-opus-4": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
    "claude-sonnet-4": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
    "claude-haiku-3-5": { input: 0.8, output: 4, cacheWrite: 1.0, cacheRead: 0.08 },
    "claude-3-5-haiku": { input: 0.8, output: 4, cacheWrite: 1.0, cacheRead: 0.08 },
};

export function priceFor(model: string, pricing: PricingTable): ModelPrice | null {
    if (pricing[model]) {
        return pricing[model];
    }

    let best: ModelPrice | null = null;
    let bestLen = -1;
    for (const [prefix, price] of Object.entries(pricing)) {
        if (model.startsWith(prefix) && prefix.length > bestLen) {
            best = price;
            bestLen = prefix.length;
        }
    }

    return best;
}

export function costOf(tokens: TokenTotals, price: ModelPrice): number {
    return (
        (tokens.input * price.input +
            tokens.output * price.output +
            tokens.cacheWrite * price.cacheWrite +
            tokens.cacheRead * price.cacheRead) /
        1_000_000
    );
}
