/** `FROM WorkItems` / `FROM WorkItemLinks` are the only tables WIQL has, so either one is decisive. */
const WIQL_TABLE = /\bfrom\s+workitem(?:link)?s\b/i;

/** A SELECT statement of any shape. On its own this could be an English query name. */
const SELECT_STATEMENT = /^\s*select\b[\s\S]*\bfrom\b/i;

/** A bracketed reference such as `[System.Id]`, which a saved query NAME never carries. */
const FIELD_REFERENCE = /\[[A-Za-z]+\.[A-Za-z]+[^\]]*\]/;

/**
 * Whether the input is a WIQL statement rather than a saved query's name, id or URL.
 *
 * This exists because fuzzy name matching accepts anything: a WIQL string scored 31% against an
 * unrelated saved query and returned that query's rows, which reads as an answer. Refusing is the
 * only safe outcome, so the test is deliberately narrow. Either the input names a WIQL table, or it
 * is a SELECT ... FROM carrying a bracketed field reference; an ordinary name matches neither.
 */
export function looksLikeWiql(input: string): boolean {
    if (WIQL_TABLE.test(input)) {
        return true;
    }

    return SELECT_STATEMENT.test(input) && FIELD_REFERENCE.test(input);
}
