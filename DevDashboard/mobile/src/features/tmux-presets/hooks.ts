import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import {
    capturePreset,
    deletePreset,
    presetsQuery,
    restorePreset,
    tmuxPresetsKeys,
} from "@/features/tmux-presets/queries";

/**
 * Component-facing tmux-presets hooks (D32). Components import THESE — never raw `useQuery`/
 * `useMutation`. The query hook is a one-liner over the active client; the mutation hooks wrap
 * `useMutation` over the same client and invalidate `["tmux-presets", "list"]` on success so the
 * list refetches (a captured preset appears, a deleted one drops out). `restore` does NOT invalidate
 * the list (it mutates the live host, not the preset library) — its result surfaces in a banner.
 *
 * ► REFERENCE SHAPE: `useX = () => useQuery(xQuery(useDashboardClient()))`.
 */

export function usePresets() {
    return useQuery(presetsQuery(useDashboardClient()));
}

export function useCapturePreset() {
    const client = useDashboardClient();
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (body: { name: string; note?: string }) => capturePreset(client, body),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: tmuxPresetsKeys.list });
        },
    });
}

export function useRestorePreset() {
    const client = useDashboardClient();

    return useMutation({
        mutationFn: (name: string) => restorePreset(client, name),
    });
}

export function useDeletePreset() {
    const client = useDashboardClient();
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (name: string) => deletePreset(client, name),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: tmuxPresetsKeys.list });
        },
    });
}
