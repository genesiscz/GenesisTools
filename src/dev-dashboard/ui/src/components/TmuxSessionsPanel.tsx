import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BezelCard } from "@ui/components/bezel-card";
import { Button } from "@ui/components/button";
import {
    GlassDialogBody,
    GlassDialogContent,
    GlassDialogDescription,
    GlassDialogEyebrow,
    GlassDialogHeader,
    GlassDialogScroll,
    GlassDialogShell,
    GlassDialogTitle,
} from "@ui/components/glass-dialog";
import { Monitor, Send, Terminal, Unlink } from "lucide-react";
import { useState } from "react";
import { CmuxSendTargetDialog } from "@/components/CmuxSendTargetDialog";
import { TmuxSessionName } from "@/components/TmuxSessionName";
import type { TmuxHubSession } from "@/lib/api";
import { cmuxApi, tmuxApi, ttydApi } from "@/lib/api";
import { canRemoveFromCmux } from "@/lib/view-state";

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onFocusTtydTab?: (ttydId: string) => void;
}

function sendToCmuxButtonClass(inCmux: boolean): string {
    if (inCmux) {
        return "font-mono text-[11px] border-white/15 bg-white/5 text-zinc-400 hover:border-white/25 hover:bg-white/10 hover:text-zinc-200";
    }

    return "font-mono text-[11px]";
}

export function TmuxSessionsPanel({ open, onOpenChange, onFocusTtydTab }: Props) {
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
        onSuccess: (data) => {
            queryClient.invalidateQueries({ queryKey: ["ttyd"] });
            queryClient.invalidateQueries({ queryKey: ["tmux"] });

            if (data?.session?.id) {
                onFocusTtydTab?.(data.session.id);
            }

            onOpenChange(false);
        },
    });

    const detach = useMutation({
        mutationFn: async (ttydTabIds: string[]) => {
            for (const id of ttydTabIds) {
                await ttydApi.kill(id, false);
            }
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["ttyd"] });
            queryClient.invalidateQueries({ queryKey: ["tmux"] });
        },
    });

    const removeFromCmux = useMutation({
        mutationFn: (tmuxSessionName: string) => cmuxApi.removeSession({ tmuxSessionName }).then((r) => r.removed),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["tmux"] });
            queryClient.invalidateQueries({ queryKey: ["cmux"] });
        },
    });

    const sessions = data ?? [];

    const handleAttach = (session: TmuxHubSession) => {
        if (session.ttydTabIds.length > 0) {
            onFocusTtydTab?.(session.ttydTabIds[0]!);
            onOpenChange(false);
            return;
        }

        attach.mutate(session.name);
    };

    return (
        <>
            <GlassDialogShell open={open} onOpenChange={onOpenChange}>
                <GlassDialogContent size="md" fixedHeight glow={false}>
                    <GlassDialogBody>
                        <GlassDialogHeader>
                            <GlassDialogEyebrow>Session hub</GlassDialogEyebrow>
                            <GlassDialogTitle className="font-mono text-lg">Tmux sessions</GlassDialogTitle>
                            <GlassDialogDescription className="font-mono text-xs text-zinc-400">
                                Attach in ttyd or send to cmux — shared tmux I/O across surfaces.
                            </GlassDialogDescription>
                        </GlassDialogHeader>

                        <GlassDialogScroll className="space-y-2">
                            {isLoading ? (
                                <p className="py-6 text-center font-mono text-sm text-zinc-500">Loading…</p>
                            ) : isError ? (
                                <p className="py-6 text-center font-mono text-sm text-rose-400">
                                    {error instanceof Error ? error.message : String(error)}
                                </p>
                            ) : sessions.length === 0 ? (
                                <p className="py-6 text-center font-mono text-sm text-zinc-500">
                                    No tmux sessions. Run{" "}
                                    <code className="text-emerald-400">tools cmux tmux create</code> or start a ttyd
                                    terminal.
                                </p>
                            ) : (
                                sessions.map((session: TmuxHubSession, index) => (
                                    <SessionRow
                                        key={session.name}
                                        session={session}
                                        index={index}
                                        attachPending={attach.isPending}
                                        detachPending={detach.isPending}
                                        removePending={removeFromCmux.isPending}
                                        onAttach={() => handleAttach(session)}
                                        onDetach={() => detach.mutate(session.ttydTabIds)}
                                        onSend={() => setSendTarget(session.name)}
                                        onRemove={
                                            canRemoveFromCmux(session)
                                                ? () => removeFromCmux.mutate(session.name)
                                                : undefined
                                        }
                                        onRenamed={(nextName) => {
                                            queryClient.invalidateQueries({ queryKey: ["tmux"] });
                                            queryClient.invalidateQueries({ queryKey: ["ttyd"] });
                                            setSendTarget((current) => (current === session.name ? nextName : current));
                                        }}
                                    />
                                ))
                            )}
                        </GlassDialogScroll>
                    </GlassDialogBody>
                </GlassDialogContent>
            </GlassDialogShell>

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
                    onRenamed={(nextName) => {
                        queryClient.invalidateQueries({ queryKey: ["tmux"] });
                        queryClient.invalidateQueries({ queryKey: ["ttyd"] });
                        setSendTarget(nextName);
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
    detachPending,
    removePending,
    onAttach,
    onDetach,
    onSend,
    onRemove,
    onRenamed,
}: {
    session: TmuxHubSession;
    index: number;
    attachPending: boolean;
    detachPending: boolean;
    removePending: boolean;
    onAttach: () => void;
    onDetach: () => void;
    onSend: () => void;
    onRemove?: () => void;
    onRenamed: (nextName: string) => void;
}) {
    const alreadyInTtyd = session.ttydTabIds.length > 0;

    return (
        <BezelCard
            className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-700"
            style={{ animationDelay: `${index * 60}ms` }}
            innerClassName="p-3"
        >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex items-start gap-2">
                        <Terminal size={14} className="mt-1 shrink-0 text-emerald-400" />
                        <TmuxSessionName name={session.name} size="md" onRenamed={onRenamed} />
                    </div>
                    <p className="font-mono text-[10px] text-zinc-500">
                        {session.windows} window(s) · {session.attached} attached
                        {alreadyInTtyd ? ` · ttyd ×${session.ttydTabIds.length}` : ""}
                        {session.inCmux && session.cmuxSurfaces.length > 0
                            ? ` · cmux ×${session.cmuxSurfaces.length}`
                            : ""}
                    </p>
                </div>
                <div className="flex shrink-0 flex-col gap-1.5">
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={attachPending}
                        onClick={onAttach}
                        className="font-mono text-[11px] text-zinc-400 transition-colors hover:border-white/20 hover:bg-white/10 hover:text-zinc-100"
                    >
                        <Monitor size={12} /> {alreadyInTtyd ? "Open in ttyd" : "Attach in ttyd"}
                    </Button>
                    {alreadyInTtyd ? (
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={detachPending}
                            onClick={onDetach}
                            className="font-mono text-[11px] text-zinc-500 transition-colors hover:border-white/20 hover:bg-white/10 hover:text-zinc-200"
                        >
                            <Unlink size={12} /> Detach from ttyd
                        </Button>
                    ) : null}
                    <Button
                        size="sm"
                        variant={session.inCmux ? "outline" : "default"}
                        onClick={onSend}
                        className={sendToCmuxButtonClass(session.inCmux)}
                    >
                        <Send size={12} /> Send to cmux
                    </Button>
                    {onRemove ? (
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={removePending}
                            onClick={onRemove}
                            className="font-mono text-[11px] text-zinc-500 transition-colors hover:border-rose-400/30 hover:bg-rose-400/10 hover:text-rose-300"
                        >
                            Remove from cmux
                        </Button>
                    ) : null}
                </div>
            </div>
        </BezelCard>
    );
}
