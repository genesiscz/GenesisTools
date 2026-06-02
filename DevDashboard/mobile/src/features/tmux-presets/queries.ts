import type { DashboardClient, TmuxPresetSummary } from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

/**
 * Tmux Presets data layer (D32 + per-feature layout). Co-locates `tmuxPresetsKeys` and the
 * `presetsQuery` `queryOptions` factory over the injected `DashboardClient`, plus the thin
 * client-caller mutations (capture / restore / remove). Uses the typed `client.presets.*` namespace
 * (added to the contract) rather than the raw escape hatch — parity with `obsidian`/`todos`.
 *
 * Polling: presets only change on a user action (save/delete) — not continuously — so a 30 s interval
 * keeps the list fresh after off-app edits (the CLI shares the same preset library) without hammering.
 */

export const tmuxPresetsKeys = {
    list: ["tmux-presets", "list"] as const,
} as const;

export const TMUX_PRESETS_INTERVAL_MS = 30_000;

export function presetsQuery(client: DashboardClient) {
    return queryOptions<TmuxPresetSummary[]>({
        queryKey: tmuxPresetsKeys.list,
        queryFn: async () => (await client.presets.list()).presets,
        refetchInterval: TMUX_PRESETS_INTERVAL_MS,
    });
}

export function capturePreset(client: DashboardClient, body: { name: string; note?: string }) {
    return client.presets.save(body);
}

export function restorePreset(client: DashboardClient, name: string) {
    return client.presets.restore(name);
}

export function deletePreset(client: DashboardClient, name: string) {
    return client.presets.remove(name);
}
