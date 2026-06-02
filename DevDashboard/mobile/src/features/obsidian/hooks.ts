import type { PublishedNote } from "@dd/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import { noteQuery, obsidianKeys, treeQuery } from "@/features/obsidian/queries";

/**
 * The contract's `obsidian.{publish,unpublish,mkdir}` methods type their responses inline (no exported
 * `Obsidian*Res` aliases), so we mirror those shapes here from the exported `PublishedNote` DTO. Keep
 * them in sync with `src/dev-dashboard/contract/client.ts` — that file is read-only for this feature.
 */
type PublishRes = { note: PublishedNote };
type UnpublishRes = { remaining: PublishedNote[] };
type MkdirRes = { ok: boolean; relativeDir: string };

/**
 * Component-facing Obsidian hooks (D32). Components import THESE — never raw `useQuery`/`useMutation`.
 * The query hooks are one-liners that grab the active client from the provider and feed the matching
 * `queryOptions` factory to `useQuery`. The mutation hooks wrap `useMutation` over the same injected
 * client and invalidate the affected query on success so the UI re-renders (tree after `mkdir`, the
 * note after `publish`/`unpublish` — the share-slug controls flip).
 *
 * ► REFERENCE SHAPE every feature copies for queries: `useX = () => useQuery(xQuery(useDashboardClient()))`.
 */

export function useVaultTree() {
    return useQuery(treeQuery(useDashboardClient()));
}

export function useNote(path: string | null) {
    return useQuery(noteQuery(useDashboardClient(), path));
}

export function usePublishNote(path: string) {
    const client = useDashboardClient();
    const queryClient = useQueryClient();

    return useMutation<PublishRes, Error, void>({
        mutationFn: () => client.obsidian.publish(path),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: obsidianKeys.note(path) });
        },
    });
}

export function useUnpublishNote(path: string) {
    const client = useDashboardClient();
    const queryClient = useQueryClient();

    return useMutation<UnpublishRes, Error, string>({
        mutationFn: (slug: string) => client.obsidian.unpublish(slug),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: obsidianKeys.note(path) });
        },
    });
}

export function useMkdir() {
    const client = useDashboardClient();
    const queryClient = useQueryClient();

    return useMutation<MkdirRes, Error, string>({
        mutationFn: (relativeDir: string) => client.obsidian.mkdir(relativeDir),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: obsidianKeys.tree });
        },
    });
}
