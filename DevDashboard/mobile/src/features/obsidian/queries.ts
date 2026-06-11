import type { DashboardClient, ObsidianNoteRes, ObsidianTreeRes } from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

/**
 * Obsidian feature data layer (D32 + per-feature layout — mirrors `features/pulse/queries.ts`). This
 * file owns BOTH the query keys (`obsidianKeys`, co-located so no shared file grows per feature) and
 * the TanStack v5 `queryOptions` FACTORIES. Each factory closes over the injected `DashboardClient`
 * and returns a fully-typed options object (key + queryFn). The thin `use*` hooks in `./hooks` pass
 * `useDashboardClient()` here and feed the result straight to `useQuery`; the publish / unpublish /
 * mkdir mutations live in `./hooks` directly (mutations are not `queryOptions`).
 *
 * Why factories over the client (not a singleton): the mock↔real client is chosen by the
 * `ClientProvider`, so the SAME factory works against fixtures or a live device — the swap is
 * invisible to callers, and a prefetch / `setQueryData` path can reuse the exact factory.
 *
 * Unlike Pulse, Obsidian is request-driven (open a note, list the vault) rather than a live metric
 * stream, so there is NO `refetchInterval` here — the tree refetches when invalidated by `mkdir`,
 * and a note refetches when invalidated by `publish`/`unpublish` (see `./hooks`).
 */

export const obsidianKeys = {
    tree: ["obsidian", "tree"] as const,
    note: (path: string) => ["obsidian", "note", path] as const,
} as const;

export function treeQuery(client: DashboardClient) {
    return queryOptions<ObsidianTreeRes>({
        queryKey: obsidianKeys.tree,
        queryFn: () => client.obsidian.tree(),
    });
}

export function noteQuery(client: DashboardClient, path: string | null) {
    return queryOptions<ObsidianNoteRes>({
        queryKey: obsidianKeys.note(path ?? ""),
        queryFn: () => client.obsidian.note(path as string),
        enabled: path !== null,
    });
}
