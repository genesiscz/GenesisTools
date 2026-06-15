/**
 * Heuristics for values that look like a secret-shaped assignment but are not a
 * real credential: template interpolations, format strings, doc/test
 * placeholders, and degenerate filler. Used by the noisy `generic-assignment`
 * and `high-entropy-base64` detectors to cut false positives; the high-precision
 * structural detectors (aws/github/slack/jwt/private-key) do not consult it.
 */

/** Interpolation / format-string markers — the value is computed, not literal. */
const INTERPOLATION_RE = /\$\{|\{\{|%[sdifjo%]|#\{/;

/** Angle-bracket or ellipsis fill-ins: `<your-key>`, `abc...`, `abc…`. */
const FILLER_RE = /<[^>]*>|\.\.\.|…/;

/** Three or more `x` in a row (`xxxxxx`, `test-key-xxx`), case-insensitive. */
const XXX_RE = /x{3,}/i;

/** A single character repeated for the whole value (`aaaaaaaaaaaa`). */
const SINGLE_CHAR_RUN_RE = /^(.)\1+$/;

/**
 * Distinctive placeholder words bounded by a non-alphanumeric edge (start, end,
 * or a separator like `-`/`_`/`.`/`/`). Boundary-anchored so we don't suppress a
 * real high-entropy secret that merely contains these letters as a substring.
 */
const PLACEHOLDER_WORD_RE =
    /(?:^|[^a-z0-9])(?:your|my|example|examples|sample|samples|placeholder|dummy|changeme|change|redacted|fake|todo|tbd|lorem|ipsum|test|testing|foobar|insert|replace|none)(?:[^a-z0-9]|$)/i;

/** True when `value` is almost certainly a placeholder rather than a real secret. */
export function isPlaceholderSecret(value: string): boolean {
    if (INTERPOLATION_RE.test(value) || FILLER_RE.test(value)) {
        return true;
    }

    if (XXX_RE.test(value) || SINGLE_CHAR_RUN_RE.test(value)) {
        return true;
    }

    return PLACEHOLDER_WORD_RE.test(value);
}
