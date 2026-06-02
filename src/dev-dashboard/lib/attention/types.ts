import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";
import type { QaRow } from "@app/question/lib/read-model";

export type AttentionKind = "agent-question" | "agent-session";

/** Where tapping an item goes. `terminal` carries the ttyd id to open; `qa` carries the
 *  read-model entry id to mark read. Discriminated so the mobile side has zero casts. */
export type AttentionDeepLink = { kind: "terminal"; ttydTabId: string } | { kind: "qa"; qaId: string };

export interface AttentionItem {
    /** Stable id — `qa:<entryId>` or `ttyd:<sessionId>` (namespaced so the two domains never collide). */
    id: string;
    kind: AttentionKind;
    /** One-line headline (the question text, or the agent session name). */
    title: string;
    /** Secondary line (project, cwd basename, or command). */
    subtitle: string;
    /** Epoch ms used for ordering + relative-time display. */
    ts: number;
    deepLink: AttentionDeepLink;
}

export interface BuildAttentionInput {
    /** Today's QA rows (already read-model rows; the route filters tag+unread, the aggregator
     *  re-filters defensively + applies the today window). */
    qaEntries: QaRow[];
    ttydSessions: TtydSession[];
    /** Injected for determinism (tests pass a fixed value). */
    now?: number;
}
