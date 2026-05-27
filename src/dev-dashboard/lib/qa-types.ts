import type { EnrichedQaEntry } from "@app/dev-dashboard/lib/qa-render";
import type { QaEntry } from "@app/question/lib/types";

export interface QaRow extends QaEntry, EnrichedQaEntry {
    supersededBy: string | null;
    readAt: number | null;
}
