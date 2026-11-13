import { ENDPOINTS } from "@app/dev-dashboard/contract/endpoint-table";
import type { CommandsRes } from "@app/dev-dashboard/contract/endpoints";
import type { SavedCommand } from "@app/dev-dashboard/lib/commands/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { CmuxSendTargetDialog } from "@/components/CmuxSendTargetDialog";
import { CommandLibrary } from "@/components/quick-commands/CommandLibrary";
import { dashboard } from "@/lib/dashboard-client";

/**
 * Quick Commands — a persistent library of one-tap command snippets. Running a snippet composes the
 * two existing exec primitives (no new shell-exec surface): `ENDPOINTS.tmuxCreate` with `{ command }` spawns a
 * tmux session that runs the snippet, then the established `CmuxSendTargetDialog` attaches that
 * session to a chosen cmux target. Mirrors the mobile Quick Commands screen for cross-surface parity.
 */
export function QuickCommandsRoute() {
    const queryClient = useQueryClient();
    const [sendSessionName, setSendSessionName] = useState<string | null>(null);

    const { data } = useQuery<CommandsRes>({
        queryKey: ["commands"],
        queryFn: () => dashboard.call(ENDPOINTS.commands, {}),
        refetchInterval: 10000,
    });

    const createMutation = useMutation({
        mutationFn: (input: { label: string; command: string }) => dashboard.call(ENDPOINTS.commandsCreate, input),
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ["commands"] });
        },
    });

    const deleteMutation = useMutation({
        mutationFn: (id: string) => dashboard.call(ENDPOINTS.commandsDelete, { id }),
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ["commands"] });
        },
    });

    const runMutation = useMutation({
        mutationFn: (cmd: SavedCommand) => dashboard.call(ENDPOINTS.tmuxCreate, { command: cmd.command }),
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
