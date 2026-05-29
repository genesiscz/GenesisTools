/** Answers longer than this get a collapsible preview (first N lines when collapsed). */
export const QA_ANSWER_PREVIEW_LINES = 3;

export function isQaAnswerTruncated(answerMd: string): boolean {
    return answerMd.split("\n").length > QA_ANSWER_PREVIEW_LINES;
}
