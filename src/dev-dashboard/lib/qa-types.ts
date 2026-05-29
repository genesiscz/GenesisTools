import type { QaEntry } from "@app/question/lib/types";

export interface EnrichedQaEntry {
    answerHtml: string;
    answerHtmlPreview: string;
    questionHtml: string;
}

export interface QaRow extends QaEntry, EnrichedQaEntry {
    supersededBy: string | null;
    readAt: number | null;
}
