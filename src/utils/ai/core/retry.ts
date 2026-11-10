/**
 * Whether a failed AI call is worth another attempt.
 *
 * The one retry predicate for every task verb. It used to be four private copies
 * (Summarizer, Translator, Embedder, Transcriber); the Transcriber copy was the
 * widest, so its body is the one kept here.
 *
 * Anything not recognised as permanent is retried, because a rate limit or a
 * dropped connection reads differently per provider and missing one costs a
 * failed command, while retrying a permanent error only costs the delay.
 */
export function isTransientAiError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);

    // Permanent HTTP errors: bad credentials, bad model, invalid input.
    if (/\b(401|403|404|400)\b/.test(msg)) {
        return false;
    }

    // Permanent provider errors.
    if (/\b(invalid.api.key|unauthorized|forbidden|model.not.found)\b/i.test(msg)) {
        return false;
    }

    // Permanent capability or format mismatches: retrying just repeats the error.
    if (/unsupported.model.version|does not support the format|unsupported.format/i.test(msg)) {
        return false;
    }

    return true;
}
