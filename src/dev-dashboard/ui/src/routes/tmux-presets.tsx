import type { TmuxPresetsRes } from "@app/dev-dashboard/contract/endpoints";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PresetCaptureForm } from "@/components/tmux-presets/PresetCaptureForm";
import { PresetsList } from "@/components/tmux-presets/PresetsList";
import { presetsApi } from "@/lib/api";

/**
 * Tmux Presets route — lists every saved layout preset, captures the current live tmux layout into a
 * new named one, and restores/deletes a preset behind an explicit `window.confirm` (same guardrail the
 * process-monitor kill flow uses). Consumes the SAME backend route the mobile app does
 * (`/api/tmux/presets`) via `presetsApi`. Restore mutates the live host, so it does NOT invalidate the
 * list; capture/delete do (a new preset appears / a deleted one drops out).
 */
export function TmuxPresetsRoute() {
    const queryClient = useQueryClient();
    const [resultLine, setResultLine] = useState<string | null>(null);

    const { data } = useQuery<TmuxPresetsRes>({
        queryKey: ["tmux-presets"],
        queryFn: () => presetsApi.list(),
        refetchInterval: 30000,
    });

    const captureMutation = useMutation({
        mutationFn: (input: { name: string; note?: string }) => presetsApi.save(input),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["tmux-presets"] });
        },
    });

    const restoreMutation = useMutation({
        mutationFn: (name: string) => presetsApi.restore(name),
        onSuccess: (res) => {
            const { name, created, skipped, failed } = res.result;
            const tail = failed > 0 ? ` · ${failed} failed` : "";
            setResultLine(`Restored "${name}": ${created} created · ${skipped} skipped${tail}`);
        },
    });

    const deleteMutation = useMutation({
        mutationFn: (name: string) => presetsApi.remove(name),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["tmux-presets"] });
        },
    });

    const handleRestore = (name: string) => {
        if (
            window.confirm(
                `Restore "${name}"? This recreates the saved tmux sessions on this machine (existing ones are skipped; the captured last command is pre-typed, not run).`
            )
        ) {
            restoreMutation.mutate(name);
        }
    };

    const handleDelete = (name: string) => {
        if (window.confirm(`Delete preset "${name}"? This removes the preset file (running tmux sessions are untouched).`)) {
            deleteMutation.mutate(name);
        }
    };

    return (
        <div className="flex flex-col gap-4">
            <div className="dd-panel flex flex-col gap-3 p-4">
                <h2 className="dd-accent-text text-lg font-semibold">Tmux Presets</h2>
                <PresetCaptureForm onCapture={captureMutation.mutate} pending={captureMutation.isPending} />
                {resultLine ? (
                    <p data-testid="tmux-presets-result" className="font-mono text-xs text-[var(--dd-accent-from)]">
                        {resultLine}
                    </p>
                ) : null}
            </div>

            {data ? (
                <PresetsList
                    presets={data.presets}
                    onRestore={handleRestore}
                    onDelete={handleDelete}
                    restoringName={restoreMutation.isPending ? restoreMutation.variables : null}
                    deletingName={deleteMutation.isPending ? deleteMutation.variables : null}
                />
            ) : (
                <div className="dd-panel flex h-40 items-center justify-center text-[var(--dd-text-muted)]">
                    Loading presets...
                </div>
            )}
        </div>
    );
}
