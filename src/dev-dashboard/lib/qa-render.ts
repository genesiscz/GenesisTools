import { renderMarkdown } from "@app/dev-dashboard/lib/obsidian/markdown";
import { isQaAnswerTruncated, QA_ANSWER_PREVIEW_LINES } from "@app/dev-dashboard/lib/qa-preview";
import type { EnrichedQaEntry } from "@app/dev-dashboard/lib/qa-types";
import type { QaEntry } from "@app/question/lib/types";

export type { EnrichedQaEntry };
export { isQaAnswerTruncated, QA_ANSWER_PREVIEW_LINES };

const noopWikilink = { resolveWikilink: () => null };

export function renderQaAnswerHtml(answerMd: string): string {
    return renderMarkdown(answerMd, noopWikilink).html;
}

export function renderQaQuestionHtml(questionMd: string): string {
    return renderMarkdown(questionMd, noopWikilink).html;
}

export function enrichQaEntry(entry: QaEntry): EnrichedQaEntry {
    const lines = entry.answerMd.split("\n");
    const answerHtml = renderQaAnswerHtml(entry.answerMd);
    const questionHtml = renderQaQuestionHtml(entry.question);
    const truncated = isQaAnswerTruncated(entry.answerMd);

    if (!truncated) {
        return { ...entry, answerHtml, answerHtmlPreview: answerHtml, questionHtml };
    }

    const previewMd = `${lines.slice(0, QA_ANSWER_PREVIEW_LINES).join("\n")}\n…`;
    const answerHtmlPreview = renderQaAnswerHtml(previewMd);

    return { ...entry, answerHtml, answerHtmlPreview, questionHtml };
}
