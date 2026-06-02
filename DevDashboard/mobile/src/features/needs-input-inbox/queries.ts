import type { AttentionRes, DashboardClient } from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

/**
 * Needs-Input Inbox data layer (D32 + per-feature layout). Co-locates `attentionKeys` and the
 * TanStack v5 `attentionQuery` factory over the injected `DashboardClient` (typed `client.attention`
 * namespace — parity with `qa`/`todos`). The thin `use*` hooks in `./hooks` feed this to `useQuery`.
 *
 * Polling: the inbox is the "what needs me now" surface, so a 15 s interval keeps the queue fresh as
 * agents ask new questions / spin up sessions, without hammering the device.
 */

export const attentionKeys = {
    list: ["attention", "list"] as const,
} as const;

export const ATTENTION_INTERVAL_MS = 15_000;

export function attentionQuery(client: DashboardClient) {
    return queryOptions<AttentionRes>({
        queryKey: attentionKeys.list,
        queryFn: () => client.attention.list(),
        refetchInterval: ATTENTION_INTERVAL_MS,
    });
}
