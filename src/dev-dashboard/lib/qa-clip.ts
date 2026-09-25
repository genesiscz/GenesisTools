/**
 * The most answer text one Q&A entry carries to the browser. An automated poster (the aws-leak
 * tripwire) wrote answers of 2.36 MB and 788 KB into the log, and /qa shipped them whole on every
 * load: 3.4 MB of JSON for 100 entries, 56,531 DOM nodes and 1.4 s of main-thread work on a fast
 * Mac, so the page never came up on the phone. The median answer is under 3 KB.
 */
export const QA_ANSWER_MAX_CHARS = 48_000;

export interface QaAnswerClip {
    /** Set only when the answer was clipped: its full length, for the "load full answer" notice. */
    answerFullChars?: number;
}

/**
 * Clips `answerMd` at the last line break before `max`, so a markdown block is never cut mid-line.
 * The full answer stays in the store; `GET /api/qa/entry/:id` returns it on demand.
 */
export function clipQaEntry<T extends { answerMd: string }>(entry: T, max = QA_ANSWER_MAX_CHARS): T & QaAnswerClip {
    if (entry.answerMd.length <= max) {
        return entry;
    }

    const lineEnd = entry.answerMd.lastIndexOf("\n", max);
    const cut = lineEnd > max / 2 ? lineEnd : max;

    return { ...entry, answerMd: entry.answerMd.slice(0, cut), answerFullChars: entry.answerMd.length };
}
