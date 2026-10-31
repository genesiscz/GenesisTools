/** Grok's session titles: the `summary.json` beside a session's `updates.jsonl`. The Grok driver's `locate` part reads them. */

/** A Grok `/rename` lands in `generated_title` with `title_is_manual: true`; it beats the generated summary. */
export function grokTitleOf(summary: Record<string, unknown>): string | null {
    const manual = summary.title_is_manual === true ? summary.generated_title : undefined;

    if (typeof manual === "string" && manual.trim() !== "") {
        return manual;
    }

    return typeof summary.session_summary === "string" && summary.session_summary.trim() !== ""
        ? summary.session_summary
        : null;
}
