import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import {
    type CmuxAttachInput,
    cmuxAttach,
    type CreateTmuxInput,
    cmuxLayoutQuery,
    cmuxSnapshotQuery,
    createTmux,
    type KillTtydInput,
    killTtyd,
    type RenameTmuxInput,
    renameTmux,
    type RenameTtydInput,
    renameTtyd,
    type SpawnTtydInput,
    spawnTtyd,
    terminalsKeys,
    tmuxSessionsQuery,
    ttydListQuery,
} from "@/features/terminals/queries";

/**
 * Component-facing Terminals hooks (D32). Screens import THESE — never raw `useQuery`/`useMutation`.
 * Read hooks are one-liners that feed a `queryOptions` factory (closing over the active client) to
 * `useQuery`. Mutation hooks wrap the thin client callers and invalidate the session inventory on
 * success so the list reflects a spawn/kill/rename without a manual refetch.
 *
 * ► Same shape pulse uses: `export const useX = () => useQuery(xQuery(useDashboardClient()))`.
 */

export function useTmuxSessions() {
    return useQuery(tmuxSessionsQuery(useDashboardClient()));
}

export function useTtydSessions() {
    return useQuery(ttydListQuery(useDashboardClient()));
}

export function useCmuxSnapshot() {
    return useQuery(cmuxSnapshotQuery(useDashboardClient()));
}

export function useCmuxLayout() {
    return useQuery(cmuxLayoutQuery(useDashboardClient()));
}

/** Invalidate every session-inventory query (tmux/ttyd/cmux) after a mutation changes the set. */
function useInvalidateSessions() {
    const qc = useQueryClient();

    return () => {
        void qc.invalidateQueries({ queryKey: terminalsKeys.tmux });
        void qc.invalidateQueries({ queryKey: terminalsKeys.ttyd });
        void qc.invalidateQueries({ queryKey: terminalsKeys.cmux.snapshot });
    };
}

export function useSpawnTtyd() {
    const client = useDashboardClient();
    const invalidate = useInvalidateSessions();

    return useMutation({
        mutationFn: (input: SpawnTtydInput) => spawnTtyd(client, input),
        onSuccess: invalidate,
    });
}

export function useKillTtyd() {
    const client = useDashboardClient();
    const invalidate = useInvalidateSessions();

    return useMutation({
        mutationFn: (input: KillTtydInput) => killTtyd(client, input),
        onSuccess: invalidate,
    });
}

export function useRenameTtyd() {
    const client = useDashboardClient();
    const invalidate = useInvalidateSessions();

    return useMutation({
        mutationFn: (input: RenameTtydInput) => renameTtyd(client, input),
        onSuccess: invalidate,
    });
}

export function useCreateTmux() {
    const client = useDashboardClient();
    const invalidate = useInvalidateSessions();

    return useMutation({
        mutationFn: (input: CreateTmuxInput) => createTmux(client, input),
        onSuccess: invalidate,
    });
}

export function useRenameTmux() {
    const client = useDashboardClient();
    const invalidate = useInvalidateSessions();

    return useMutation({
        mutationFn: (input: RenameTmuxInput) => renameTmux(client, input),
        onSuccess: invalidate,
    });
}

export function useCmuxAttach() {
    const client = useDashboardClient();
    const invalidate = useInvalidateSessions();

    return useMutation({
        mutationFn: (input: CmuxAttachInput) => cmuxAttach(client, input),
        onSuccess: invalidate,
    });
}
