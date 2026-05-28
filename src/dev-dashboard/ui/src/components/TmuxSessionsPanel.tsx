import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@ui/components/dialog";
import { Monitor, Send, Terminal } from "lucide-react";
import { useState } from "react";
import { CmuxSendTargetDialog } from "@/components/CmuxSendTargetDialog";
import { tmuxApi, ttydApi } from "@/lib/api";
import type { TmuxHubSession } from "@/lib/api";

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function TmuxSessionsPanel({ open, onOpenChange }: Props) {
    const queryClient = useQueryClient();
    const [sendTarget, setSendTarget] = useState<string | null>(null);

    const { data, isLoading, isError, error } = useQuery({
        queryKey: ["tmux", "sessions"],
        queryFn: () => tmuxApi.sessions().then((r) => r.sessions),
        enabled: open,
        refetchInterval: open ? 3000 : false,
    });

    const attach = useMutation({
        mutationFn: (tmuxSessionName: string) => ttydApi.spawn({ tmuxSessionName }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["ttyd"] });
            queryClient.invalidateQueries({ queryKey: ["tmux"] });
        },
    });

    const sessions = data ?? [];

    return (
        <>
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent className="dd-panel max-h-[min(85dvh,720px)] w-[min(96vw,640px)] max-w-none overflow-hidden border-white/10 bg-[#050505]/95 sm:max-w-none">
                    <DialogHeader>
                        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--dd-text-muted)]">
                            Session hub
                        </p>
                        <DialogTitle className="font-mono text-lg">Tmux sessions</DialogTitle>
                        <DialogDescription className="font-mono text-xs">
                            Attach in ttyd or send to cmux — shared tmux I/O across surfaces.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="max-h-[50dvh] space-y-2 overflow-y-auto pr-1">
                        {isLoading ? (
                            <p className="py-6 text-center font-mono text-sm text-[var(--dd-text-muted)]">Loading…</p>
                        ) : isError ? (
                            <p className="py-6 text-center font-mono text-sm text-[#f87171]">
                                {error instanceof Error ? error.message : String(error)}
                            </p>
                        ) : sessions.length === 0 ? (
                            <p className="py-6 text-center font-mono text-sm text-[var(--dd-text-muted)]">
                                No tmux sessions. Start a ttyd terminal or cmux + pane.
                            </p>
                        ) : (
                            sessions.map((session: TmuxHubSession, index) => (
                                <SessionRow
                                    key={session.name}
                                    session={session}
                                    index={index}
                                    attachPending={attach.isPending}
                                    onAttach={() => attach.mutate(session.name)}
                                    onSend={() => setSendTarget(session.name)}
                                />
                            ))
                        )}
                    </div>
                </DialogContent>
            </Dialog>

            {sendTarget ? (
                <CmuxSendTargetDialog
                    open
                    tmuxSessionName={sendTarget}
                    onOpenChange={(next) => {
                        if (!next) {
                            setSendTarget(null);
                        }
                    }}
                    onSent={() => {
                        queryClient.invalidateQueries({ queryKey: ["tmux"] });
                        queryClient.invalidateQueries({ queryKey: ["cmux"] });
                        setSendTarget(null);
                    }}
                />
            ) : null}
        </>
    );
}

function SessionRow({
    session,
    index,
    attachPending,
    onAttach,
    onSend,
}: {
    session: TmuxHubSession;
    index: number;
    attachPending: boolean;
    onAttach: () => void;
    onSend: () => void;
}) {
    return (
        <div
            className="rounded-[1rem] bg-white/5 p-1 ring-1 ring-white/10 animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-700"
            style={{ animationDelay: `${index * 60}ms` }}
        >
            <div className="flex flex-col gap-2 rounded-[calc(1rem-0.25rem)] bg-[var(--dd-bg-elevated)] p-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 font-mono text-sm text-[var(--dd-text-primary)]">
                        <Terminal size={14} className="shrink-0 text-[var(--dd-accent-from)]" />
                        <span className="truncate">{session.name}</span>
                    </div>
                    <p className="mt-1 font-mono text-[10px] text-[var(--dd-text-muted)]">
                        {session.windows} window(s) · {session.attached} attached
                        {session.ttydTabIds.length > 0 ? ` · ttyd ×${session.ttydTabIds.length}` : ""}
                    </p>
                </div>
                <div className="flex shrink-0 gap-2">
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={!session.canAttachInTtyd || attachPending}
                        onClick={onAttach}
                        className="font-mono text-[11px]"
                    >
                        <Monitor size={12} /> Attach in ttyd
                    </Button>
                    <Button size="sm" onClick={onSend} className="font-mono text-[11px]">
                        <Send size={12} /> Send to cmux
                    </Button>
                </div>
            </div>
        </div>
    );
}
