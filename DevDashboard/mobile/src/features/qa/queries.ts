import { type DashboardClient, ENDPOINTS, type QaRow } from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

/**
 * The entry as the Mac stores it. The log and the live `qa` channel clip a long answer (`answerFullChars` is its real
 * length), so an action that keeps the answer, such as saving it to the vault, reads the whole entry first.
 */
export async function fullQaEntry(client: DashboardClient, entry: QaRow): Promise<QaRow> {
    if (entry.answerFullChars === undefined) {
        return entry;
    }

    return (await client.call(ENDPOINTS.qaEntry, { id: entry.id })).entry;
}

/**
 * QA feature data layer (D32 + the per-feature layout from plan 05). This file owns BOTH the query
 * keys (`qaKeys`, co-located so no shared file grows per feature) and the TanStack v5 `queryOptions`
 * FACTORY for the persisted Q&A log. The factory closes over the injected `DashboardClient`; the
 * thin `use*` hooks in `./hooks` pass `useDashboardClient()` here and feed the result to `useQuery`.
 * Components import the hooks — never raw `useQuery` (hard D32 rule).
 *
 * ── Contract-narrowing note (boundary cast lives HERE, exactly once) ────────────────────────────
 * The server runs `enrichQaEntry(row)` on BOTH `/api/qa/log` (vite-middleware.ts:551) and the SSE
 * (:640). `enrichQaEntry` does `{ ...entry, answerHtml, answerHtmlPreview, questionHtml }`, and
 * `entry` is a full `QaRow` (`queryEntries(): QaRow[]` — base `QaEntry` + `supersededBy` + `readAt`).
 * So the runtime payload IS a `QaRow`. The shipped contract, however, types `QaLogRes.entries` and
 * the live `qa` channel's entry as the NARROWER `EnrichedQaEntry` (just the 3 HTML fields) — a known
 * contract-typing bug we cannot fix here (contract files are read-only this pass; flagged in the
 * notes). We assert the real shape ONCE, in the queryFn boundary, so every consumer downstream sees
 * `QaRow[]` with zero casts. The transport's own `qa-stream.ts` already does the identical cast.
 */

export const qaKeys = {
    log: (params?: QaLogParams) => ["qa", "log", params ?? {}] as const,
    /** The live window the `qa` channel fills (`live/cache-table.ts`); no request reads it. */
    live: ["qa", "live"] as const,
} as const;

export interface QaLogParams {
    project?: string;
    tag?: string;
    unread?: boolean;
    limit?: number;
}

export const QA_LOG_INTERVAL_MS = 30_000;
export const QA_LOG_DEFAULT_LIMIT = 100;

export function qaLogQuery(client: DashboardClient, params: QaLogParams = {}) {
    return queryOptions<QaRow[]>({
        queryKey: qaKeys.log(params),
        queryFn: async () => {
            const res = await client.qa.log({ limit: QA_LOG_DEFAULT_LIMIT, ...params });
            // Boundary cast: the runtime payload is a full QaRow (see file header). The contract
            // narrows it to EnrichedQaEntry, so this single assertion restores the real shape.
            return res.entries as QaRow[];
        },
        refetchInterval: QA_LOG_INTERVAL_MS,
    });
}
