import type { CmuxLayoutTree, DashboardSendTarget } from "@app/dev-dashboard/lib/cmux/types";
import { DEV_DASHBOARD_WORKSPACE } from "@app/dev-dashboard/lib/tmux/constants";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BezelCard } from "@ui/components/bezel-card";
import { Button } from "@ui/components/button";
import {
    GlassDialogBody,
    GlassDialogContent,
    GlassDialogDescription,
    GlassDialogEyebrow,
    GlassDialogFooter,
    GlassDialogHeader,
    GlassDialogScroll,
    GlassDialogShell,
    GlassDialogTitle,
} from "@ui/components/glass-dialog";
import { ArrowUpRight, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CmuxLayoutTreePicker, type CmuxPickKind } from "@/components/CmuxLayoutTree";
import { TmuxSessionName, TmuxSessionNameLabel } from "@/components/TmuxSessionName";
import { cmuxApi, tmuxApi } from "@/lib/api";
import { invalidateTmuxAndTtyd } from "@/lib/query-keys";
import { canRemoveFromCmux } from "@/lib/view-state";

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    tmuxSessionName: string;
    onSent?: () => void;
    onRenamed?: (nextName: string) => void;
}

export function CmuxSendTargetDialog({ open, onOpenChange, tmuxSessionName, onSent, onRenamed }: Props) {
    const queryClient = useQueryClient();
    const [sessionName, setSessionName] = useState(tmuxSessionName);

    useEffect(() => {
        setSessionName(tmuxSessionName);
    }, [tmuxSessionName]);

    const { data: hubSessions } = useQuery({
        queryKey: ["tmux", "sessions"],
        queryFn: () => tmuxApi.sessions().then((r) => r.sessions),
        enabled: open,
        staleTime: 2000,
    });

    const hubSession = hubSessions?.find((session) => session.name === sessionName);
    const inCmux = (hubSession?.cmuxSurfaces.length ?? 0) > 0;
    const canRemove = hubSession ? canRemoveFromCmux(hubSession) : false;

    const { data, isLoading, isError } = useQuery({
        queryKey: ["cmux", "layout"],
        queryFn: () => cmuxApi.layout().then((r) => r.layout),
        enabled: open,
        staleTime: 2000,
    });

    const layout: CmuxLayoutTree | undefined = data;
    const [windowId, setWindowId] = useState<string | null>(null);
    const [workspaceId, setWorkspaceId] = useState<string | null>(null);
    const [paneId, setPaneId] = useState<string | null>(null);
    const [surfaceId, setSurfaceId] = useState<string | null>(null);
    const [pickKind, setPickKind] = useState<CmuxPickKind | null>(null);

    const send = useMutation({
        mutationFn: (target: DashboardSendTarget) =>
            cmuxApi.sendSession({ tmuxSessionName: sessionName, target }).then((r) => r.result),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["cmux"] });
            queryClient.invalidateQueries({ queryKey: ["tmux"] });
            onSent?.();
            onOpenChange(false);
        },
    });

    const removeFromCmux = useMutation({
        mutationFn: () => cmuxApi.removeSession({ tmuxSessionName: sessionName }).then((r) => r.removed),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["cmux"] });
            queryClient.invalidateQueries({ queryKey: ["tmux"] });
        },
    });

    const createWorkspace = useMutation({
        mutationFn: (body: { windowId: string; name?: string }) => cmuxApi.createWorkspace(body).then((r) => r.result),
        onSuccess: (result) => {
            queryClient.invalidateQueries({ queryKey: ["cmux", "layout"] });
            setWindowId(result.windowId);
            setWorkspaceId(result.workspaceId);
            setPaneId("");
            setSurfaceId("");
            setPickKind("new_split");
        },
    });

    const resolvedTarget = useMemo((): DashboardSendTarget | null => {
        if (pickKind === "new_split" && workspaceId) {
            return { mode: "new_split", workspaceId };
        }

        if (pickKind === "new_surface" && workspaceId && paneId) {
            return { mode: "new_surface", workspaceId, paneId };
        }

        if (pickKind === "existing_surface" && workspaceId && surfaceId) {
            return { mode: "existing_surface", workspaceId, surfaceId };
        }

        return null;
    }, [paneId, pickKind, surfaceId, workspaceId]);

    const canSend = resolvedTarget !== null && !send.isPending;
    const selectedWindowId = windowId ?? layout?.windows[0]?.id ?? null;

    return (
        <GlassDialogShell open={open} onOpenChange={onOpenChange}>
            <GlassDialogContent size="lg" fixedHeight showCloseButton>
                <GlassDialogBody>
                    <GlassDialogHeader className="shrink-0 space-y-2 text-left">
                        <GlassDialogEyebrow>Send to cmux</GlassDialogEyebrow>
                        <GlassDialogTitle className="font-mono text-lg">Port tmux session</GlassDialogTitle>
                        <GlassDialogDescription className="flex flex-wrap items-center gap-2 font-mono text-xs text-zinc-400">
                            <TmuxSessionNameLabel>Session</TmuxSessionNameLabel>
                            <TmuxSessionName
                                name={sessionName}
                                size="sm"
                                onRenamed={(nextName) => {
                                    setSessionName(nextName);
                                    invalidateTmuxAndTtyd(queryClient);
                                    onRenamed?.(nextName);
                                }}
                            />
                            {inCmux ? (
                                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-zinc-500">
                                    already in cmux
                                </span>
                            ) : null}
                        </GlassDialogDescription>
                    </GlassDialogHeader>

                    <GlassDialogScroll className="flex min-h-0 flex-1 flex-col gap-4">
                        <BezelCard
                            as="button"
                            type="button"
                            disabled={send.isPending}
                            onClick={() => send.mutate({ mode: "quick_dev_dashboard" })}
                            className="group w-full text-left transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-0.5 active:scale-[0.99] disabled:opacity-50"
                            innerClassName="px-4 py-4"
                        >
                            <span className="flex items-center gap-3">
                                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                                    <Sparkles size={16} />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block font-mono text-sm font-semibold text-zinc-100">
                                        {DEV_DASHBOARD_WORKSPACE} workspace
                                    </span>
                                    <span className="block text-[11px] text-zinc-500">
                                        New split · canonical handoff target
                                    </span>
                                </span>
                                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-px">
                                    <ArrowUpRight size={14} />
                                </span>
                            </span>
                        </BezelCard>

                        <p className="shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                            or choose destination
                        </p>

                        <div className="min-h-[320px] flex-1">
                            {isLoading ? (
                                <div className="flex h-full min-h-[320px] items-center justify-center font-mono text-sm text-zinc-500">
                                    Loading layout…
                                </div>
                            ) : isError || !layout?.available ? (
                                <div className="flex h-full min-h-[320px] items-center justify-center font-mono text-sm text-rose-400">
                                    {layout?.error ?? "Failed to load cmux layout"}
                                </div>
                            ) : (
                                <CmuxLayoutTreePicker
                                    layout={layout}
                                    windowId={windowId}
                                    workspaceId={workspaceId}
                                    paneId={paneId}
                                    surfaceId={surfaceId}
                                    pickKind={pickKind}
                                    creatingWorkspace={createWorkspace.isPending}
                                    onWindowId={setWindowId}
                                    onWorkspaceId={setWorkspaceId}
                                    onPaneId={setPaneId}
                                    onSurfaceId={setSurfaceId}
                                    onPickKind={setPickKind}
                                    onCreateWorkspace={
                                        selectedWindowId
                                            ? () => {
                                                  createWorkspace.mutate({ windowId: selectedWindowId });
                                              }
                                            : undefined
                                    }
                                />
                            )}
                        </div>

                        {send.isError ? (
                            <p className="font-mono text-xs text-rose-400">
                                {send.error instanceof Error ? send.error.message : String(send.error)}
                            </p>
                        ) : null}

                        {createWorkspace.isError ? (
                            <p className="font-mono text-xs text-rose-400">
                                {createWorkspace.error instanceof Error
                                    ? createWorkspace.error.message
                                    : String(createWorkspace.error)}
                            </p>
                        ) : null}

                        {removeFromCmux.isError ? (
                            <p className="font-mono text-xs text-rose-400">
                                {removeFromCmux.error instanceof Error
                                    ? removeFromCmux.error.message
                                    : String(removeFromCmux.error)}
                            </p>
                        ) : null}
                    </GlassDialogScroll>

                    <GlassDialogFooter className="shrink-0 gap-2 sm:justify-end">
                        {canRemove ? (
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={removeFromCmux.isPending}
                                onClick={() => removeFromCmux.mutate()}
                                className="mr-auto font-mono text-[11px] text-zinc-500 hover:border-rose-400/30 hover:bg-rose-400/10 hover:text-rose-300"
                            >
                                Remove from cmux
                            </Button>
                        ) : null}
                        <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            disabled={!canSend}
                            onClick={() => {
                                if (resolvedTarget) {
                                    send.mutate(resolvedTarget);
                                }
                            }}
                            className="group rounded-full px-5 transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.98]"
                        >
                            Send here
                            <span className="ml-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/20 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-px">
                                <ArrowUpRight size={12} />
                            </span>
                        </Button>
                    </GlassDialogFooter>
                </GlassDialogBody>
            </GlassDialogContent>
        </GlassDialogShell>
    );
}
