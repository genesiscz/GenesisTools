import type { SavedCommand } from "@app/dev-dashboard/lib/commands/types";
import type { CommandsRes } from "@app/dev-dashboard/contract/endpoints";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { CmuxSendTargetDialog } from "@/components/CmuxSendTargetDialog";
import { CommandLibrary } from "@/components/quick-commands/CommandLibrary";
import { commandsApi, tmuxApi } from "@/lib/api";

/**
 * Quick Commands — a persistent library of one-tap command snippets. Running a snippet composes the
 * two existing exec primitives (no new shell-exec surface): `tmuxApi.create({ command })` spawns a
 * tmux session that runs the snippet, then the established `CmuxSendTargetDialog` attaches that
 * session to a chosen cmux target. Mirrors the mobile Quick Commands screen for cross-surface parity.
 */
export function QuickCommandsRoute() {
    const queryClient = useQueryClient();
    const [sendSessionName, setSendSessionName] = useState<string | null>(null);

    const { data } = useQuery<CommandsRes>({
        queryKey: ["commands"],
        queryFn: () => commandsApi.list(),
        refetchInterval: 10000,
    });

    const createMutation = useMutation({
        mutationFn: (input: { label: string; command: string }) => commandsApi.create(input),
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ["commands"] });
        },
    });

    const deleteMutation = useMutation({
        mutationFn: (id: string) => commandsApi.remove(id),
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ["commands"] });
        },
    });

    const runMutation = useMutation({
        mutationFn: (cmd: SavedCommand) => tmuxApi.create({ command: cmd.command }),
        onSuccess: (created) => {
            // Hand the freshly-spawned session to the send-target dialog to attach it to a cmux target.
            setSendSessionName(created.sessionName);
            queryClient.invalidateQueries({ queryKey: ["tmux"] });
        },
    });

    return (
        <div className="min-h-[calc(100vh-2rem)]">
            <CommandLibrary
                commands={data?.commands ?? []}
                onRun={(cmd) => runMutation.mutate(cmd)}
                onCreate={(input) => createMutation.mutate(input)}
                onDelete={(id) => deleteMutation.mutate(id)}
                creating={createMutation.isPending}
                runningId={runMutation.isPending ? (runMutation.variables?.id ?? null) : null}
                deletingId={deleteMutation.isPending ? (deleteMutation.variables ?? null) : null}
            />

            {sendSessionName ? (
                <CmuxSendTargetDialog
                    open={sendSessionName !== null}
                    onOpenChange={(open) => {
                        if (!open) {
                            setSendSessionName(null);
                        }
                    }}
                    tmuxSessionName={sendSessionName}
                    onSent={() => setSendSessionName(null)}
                />
            ) : null}
        </div>
    );
}
