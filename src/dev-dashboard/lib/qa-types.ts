import type { QaAnswerClip } from "@app/dev-dashboard/lib/qa-clip";
import type { QaEntry } from "@app/question/lib/types";

export interface EnrichedQaEntry {
    answerHtml: string;
    answerHtmlPreview: string;
    questionHtml: string;
}

export interface QaRow extends QaEntry, Partial<EnrichedQaEntry>, QaAnswerClip {
    supersededBy: string | null;
    readAt: number | null;
}
