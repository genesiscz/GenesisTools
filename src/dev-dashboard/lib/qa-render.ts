import { renderMarkdown } from "@app/dev-dashboard/lib/obsidian/markdown";
import type { QaEntry } from "@app/question/lib/types";

const noopWikilink = { resolveWikilink: () => null };

/** Answers longer than this get a collapsible preview (first N lines when collapsed). */
export const QA_ANSWER_PREVIEW_LINES = 50;

export function isQaAnswerTruncated(answerMd: string): boolean {
    return answerMd.split("\n").length > QA_ANSWER_PREVIEW_LINES;
}

export function renderQaAnswerHtml(answerMd: string): string {
    return renderMarkdown(answerMd, noopWikilink).html;
}

export type EnrichedQaEntry = QaEntry & {
    answerHtml: string;
    answerHtmlPreview: string;
};

export function enrichQaEntry(entry: QaEntry): EnrichedQaEntry {
    const lines = entry.answerMd.split("\n");
    const answerHtml = renderQaAnswerHtml(entry.answerMd);
    const truncated = isQaAnswerTruncated(entry.answerMd);

    if (!truncated) {
        return { ...entry, answerHtml, answerHtmlPreview: answerHtml };
    }

    const previewMd = `${lines.slice(0, QA_ANSWER_PREVIEW_LINES).join("\n")}\n…`;
    const answerHtmlPreview = renderQaAnswerHtml(previewMd);

    return { ...entry, answerHtml, answerHtmlPreview };
}
