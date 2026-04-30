import { type Expression, type ExpressionBuilder, type ReferenceExpression, type SqlBool, sql } from "kysely";

export function escapeLike(value: string, escapeChar = "\\"): string {
    return value.replace(/[\\%_]/g, (match) => `${escapeChar}${match}`);
}

export interface LikePredicateBuilder<DB, TB extends keyof DB> {
    /** Returns one Expression per token: each token must match at least one column. */
    expressions(eb: ExpressionBuilder<DB, TB>): Expression<SqlBool>[];
}

/**
 * Build a tokenized LIKE predicate: each token must match at least one of the
 * provided columns (any-order match). Pair with an ordered `%tok1%tok2%` pattern
 * if you also want to bias toward in-order phrases.
 *
 * Example:
 *   const pred = buildLikePredicate(tokens, ["s.subject", "a.address"]);
 *   .where(eb => eb.and(pred.expressions(eb)))
 */
export function buildLikePredicate<DB, TB extends keyof DB>(
    tokens: string[],
    columns: ReferenceExpression<DB, TB>[],
    escapeChar = "\\"
): LikePredicateBuilder<DB, TB> {
    const escapedTokens = tokens.map((t) => `%${escapeLike(t, escapeChar)}%`);

    return {
        expressions(eb) {
            return escapedTokens.map((pattern) =>
                eb.or(columns.map((col) => sql<SqlBool>`${eb.ref(col as never)} LIKE ${pattern} ESCAPE ${escapeChar}`))
            );
        },
    };
}

/** Build an ordered wildcard pattern: %tok1%tok2%tok3%. Useful for phrase-like matches. */
export function buildOrderedLikePattern(tokens: string[], escapeChar = "\\"): string {
    return `%${tokens.map((t) => escapeLike(t, escapeChar)).join("%")}%`;
}
