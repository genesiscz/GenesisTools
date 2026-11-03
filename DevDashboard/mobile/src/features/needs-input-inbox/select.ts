import type { AttentionItem, WaitingSessionDto } from "@dd/contract";
import { queueSessionKey } from "@/features/answer-queue/units";

/**
 * Pure display helpers for the Needs-Input Inbox (no React, no I/O — tested in `select.test.ts`,
 * mirrors qa's `live-feed`/`units`). The server already sorts + filters; these are presentation-only.
 */

export interface AttentionPartition {
    questions: AttentionItem[];
    sessions: AttentionItem[];
}

/** Splits the queue into agent questions vs live agent sessions, preserving server order. */
export function partitionAttention(items: AttentionItem[]): AttentionPartition {
    const questions: AttentionItem[] = [];
    const sessions: AttentionItem[] = [];

    for (const item of items) {
        if (item.kind === "agent-question") {
            questions.push(item);
        } else {
            sessions.push(item);
        }
    }

    return { questions, sessions };
}

export function attentionCount(items: AttentionItem[]): number {
    return items.length;
}

/** Namespaced id → a valid accessibility-id segment (`qa:mock-1` → `qa-mock-1`). */
export function attentionItemTestId(id: string): string {
    return `needs-input-inbox-item-${id.replace(/:/g, "-")}`;
}

/** A short relative time ("now", "5m", "3h", "2d") from an epoch-ms timestamp. */
export function relativeTime(ts: number | undefined, now: number = Date.now()): string {
    if (ts == null || Number.isNaN(ts)) {
        return "—";
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
/**
 * One row of the Needs Input list: an answer-queue session card, an attention item, or the attention section's
 * loading, error or "All clear" line.
 */
export type InboxRow =
    | { kind: "session"; session: WaitingSessionDto }
    | { kind: "attention"; item: AttentionItem }
    | { kind: "status" };

export interface InboxSection {
    key: "queue" | "attention";
    data: InboxRow[];
}

/**
 * The Needs Input screen as one virtualized list: the answer queue's sessions, then the attention items. Both are
 * rows, never a list header, so only the cards on screen mount. An empty attention list is one status row.
 */
export function inboxSections({
    sessions,
    items,
}: {
    sessions: readonly WaitingSessionDto[];
    items: readonly AttentionItem[];
}): InboxSection[] {
    const attention: InboxRow[] = items.map((item) => ({ kind: "attention", item }));

    return [
        { key: "queue", data: sessions.map((session) => ({ kind: "session", session })) },
        { key: "attention", data: attention.length > 0 ? attention : [{ kind: "status" }] },
    ];
}

/** The row's key: a session card keeps the key it had in the queue, an attention item its id. */
export function inboxRowKey(row: InboxRow): string {
    if (row.kind === "session") {
        return queueSessionKey(row.session);
    }

    return row.kind === "attention" ? row.item.id : "attention-status";
}
