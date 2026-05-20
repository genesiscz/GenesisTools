import { renderMarkdown } from "@app/dev-dashboard/lib/obsidian/markdown";
import type { QaEntry } from "@app/question/lib/types";

const noopWikilink = { resolveWikilink: () => null };

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
    const truncated = lines.length > 3;

    if (!truncated) {
        return { ...entry, answerHtml, answerHtmlPreview: answerHtml };
    }

    const previewMd = `${lines.slice(0, 3).join("\n")}\n…`;
    const answerHtmlPreview = renderQaAnswerHtml(previewMd);

    return { ...entry, answerHtml, answerHtmlPreview };
}
