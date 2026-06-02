import type { QaRow } from "@dd/contract";

/**
 * Pure QA feature formatters (runtime-free; no `@app/*` import — that would drag web/server code
 * into the RN bundle). Mirrors the web `qa-preview.ts` truncation rule and adds mobile display
 * helpers. Tested in `units.test.ts` (same rationale as Pulse's `units.ts`). Defensive against the
 * thin mock fixtures (missing `answerMd`/`ts`/`tag`).
 */

export const DASH = "—";

/** Answers longer than this get a collapsible preview (first N lines when collapsed). Mirrors web. */
export const QA_ANSWER_PREVIEW_LINES = 3;

export function isAnswerTruncated(answerMd: string | undefined): boolean {
    if (!answerMd) {
        return false;
    }

    return answerMd.split("\n").length > QA_ANSWER_PREVIEW_LINES;
}

/** The collapsed preview: first N lines + an ellipsis when truncated, else the whole answer. */
export function answerPreview(answerMd: string | undefined): string {
    if (!answerMd) {
        return DASH;
    }

    if (!isAnswerTruncated(answerMd)) {
        return answerMd;
    }

    return `${answerMd.split("\n").slice(0, QA_ANSWER_PREVIEW_LINES).join("\n")}\n…`;
}

/** A short relative time ("now", "5m", "3h", "2d") from an epoch-ms timestamp. */
export function relativeTime(ts: number | undefined, now: number = Date.now()): string {
    if (ts == null || Number.isNaN(ts)) {
        return DASH;
    }

    const sec = Math.max(0, Math.round((now - ts) / 1000));

    if (sec < 45) {
        return "now";
    }

    const min = Math.round(sec / 60);

    if (min < 60) {
        return `${min}m`;
    }

    const hr = Math.round(min / 60);

    if (hr < 24) {
        return `${hr}h`;
    }

    return `${Math.round(hr / 24)}d`;
}

export type QaTagTone = "accent" | "muted" | "danger";

/** Maps a QA tag to a StatusPill tone (question→accent, action→accent, directive→danger). */
export function tagTone(tag: QaRow["tag"] | undefined): QaTagTone {
    if (tag === "directive") {
        return "danger";
    }

    if (tag === "action") {
        return "accent";
    }

    return "muted";
}

/** An entry is unread when the server has no `readAt` for it. Tolerates missing field. */
export function isUnread(row: Pick<QaRow, "readAt">): boolean {
    return row.readAt == null;
}
