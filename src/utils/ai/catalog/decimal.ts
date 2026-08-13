/**
 * Per-token to per-1M conversion without the double-rounding noise.
 *
 * `Number.parseFloat("0.0000002") * 1_000_000` is the obvious spelling and it is
 * wrong: the parse rounds to the nearest double, then the multiply rounds again,
 * so the answer is `0.19999999999999998`. 70 of OpenRouter's 410 models produce
 * that shape of noise, which then leaks into every cost total derived from them.
 *
 * Moving the exponent INSIDE the string makes the runtime compute the exact
 * mathematical value once and round once, which is how `Number("0.0000002e6")`
 * lands on the same double as the literal `0.2`.
 *
 * Its own file rather than the openrouter module because `catalog/litellm.ts`
 * has the identical `* 1_000_000` bug on four fields and can adopt it.
 */

const PER_1M_SHIFT = 6;

/** Rewrites `<mantissa>e<exp>` as `<mantissa>e<exp + places>`; plain decimals just gain an exponent. */
function shiftDecimalPoint(raw: string, places: number): string {
    const exponent = /^([+-]?[0-9.]+)[eE]([+-]?[0-9]+)$/.exec(raw);

    if (!exponent) {
        return `${raw}e${places}`;
    }

    return `${exponent[1]}e${Number(exponent[2]) + places}`;
}

/**
 * USD per token to USD per 1M tokens.
 *
 * Returns `undefined` for anything that cannot be a rate: unparseable input, a
 * non-finite value, or a negative one. Negatives are not hypothetical —
 * OpenRouter quotes `-1` on its five meta routes (`openrouter/auto`,
 * `auto-beta`, `fusion`, `pareto-code`, `bodybuilder`), which the old converter
 * turned into `inputPer1M: -1_000_000` and then SUBTRACTED from cost aggregates
 * for a cache hour. An explicit `0` is preserved, because `:free` routes really
 * do quote zero.
 */
export function perTokenToPer1M(value: string | number): number | undefined {
    const raw = typeof value === "number" ? String(value) : value.trim();

    if (raw.length === 0) {
        return undefined;
    }

    const converted = Number(shiftDecimalPoint(raw, PER_1M_SHIFT));

    if (!Number.isFinite(converted) || converted < 0) {
        return undefined;
    }

    return converted;
}
