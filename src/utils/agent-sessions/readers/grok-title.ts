/**
 * Grok's session titles, read by one rule from the `summary.json` beside a session's chat history. Discovery
 * (`grok-discovery.ts`), the reader's metadata (`grok.ts`) and title search (`grok-locate.ts`) all use it.
 *
 * - The title is `generated_title`: the name Grok gives the session, which a `/rename` replaces (with
 *   `title_is_manual: true`). The session lists show it, so a title search matches the same name a person reads
 *   there.
 * - The summary is `session_summary`, the fallback name of a session that has no title yet.
 */

function nonEmpty(value: unknown): string | null {
    return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The name of a Grok session (generated or renamed), or null when it has none yet. */
export function grokSessionTitleOf(summary: Record<string, unknown>): string | null {
    return nonEmpty(summary.generated_title);
}

/** The generated summary of a Grok session, or null. */
export function grokSummaryOf(summary: Record<string, unknown>): string | null {
    return nonEmpty(summary.session_summary);
}

/** The name a title search matches: the session's title, else its summary. */
export function grokTitleOf(summary: Record<string, unknown>): string | null {
    return grokSessionTitleOf(summary) ?? grokSummaryOf(summary);
}
