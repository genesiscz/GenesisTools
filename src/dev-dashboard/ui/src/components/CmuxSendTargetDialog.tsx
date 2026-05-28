import type { CmuxLayoutTree, DashboardSendTarget } from "@app/dev-dashboard/lib/cmux/types";
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
import { ArrowUpRight, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { CmuxLayoutTreePicker } from "@/components/CmuxLayoutTree";
import { cmuxApi } from "@/lib/api";
import { DEV_DASHBOARD_WORKSPACE } from "@app/dev-dashboard/lib/tmux/constants";

type DeliveryMode = "new_split" | "new_surface" | "existing_surface";

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    tmuxSessionName: string;
    onSent?: () => void;
}

function DoubleBezel({ children, className = "" }: { children: ReactNode; className?: string }) {
    return (
        <div className={`rounded-[1.25rem] bg-white/5 p-1.5 ring-1 ring-white/10 ${className}`}>
            <div className="rounded-[calc(1.25rem-0.375rem)] bg-[var(--dd-bg-elevated)] shadow-[inset_0_1px_1px_rgba(255,255,255,0.08)]">
                {children}
            </div>
        </div>
    );
}

export function CmuxSendTargetDialog({ open, onOpenChange, tmuxSessionName, onSent }: Props) {
    const queryClient = useQueryClient();
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
    const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>("new_split");

    const send = useMutation({
        mutationFn: (target: DashboardSendTarget) =>
            cmuxApi.sendSession({ tmuxSessionName, target }).then((r) => r.result),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["cmux"] });
            onSent?.();
            onOpenChange(false);
        },
    });

    const resolvedTarget = useMemo((): DashboardSendTarget | null => {
        if (deliveryMode === "new_split" && workspaceId) {
            return { mode: "new_split", workspaceId };
        }

        if (deliveryMode === "new_surface" && workspaceId && paneId) {
            return { mode: "new_surface", workspaceId, paneId };
        }

        if (deliveryMode === "existing_surface" && workspaceId && surfaceId) {
            return { mode: "existing_surface", workspaceId, surfaceId };
        }

        return null;
    }, [deliveryMode, paneId, surfaceId, workspaceId]);

    const canSend = resolvedTarget !== null && !send.isPending;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                showCloseButton
                className="dd-panel max-h-[min(90dvh,820px)] w-[min(96vw,960px)] max-w-none gap-0 overflow-hidden border-white/10 bg-[#050505]/95 p-0 shadow-[0_0_80px_rgba(0,0,0,0.65)] backdrop-blur-xl sm:max-w-none"
            >
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(56,189,248,0.08),transparent_55%)]" />
                <div className="relative flex flex-col gap-4 p-5 sm:p-6">
                    <DialogHeader className="space-y-2 text-left">
                        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--dd-text-muted)]">
                            Send to cmux
                        </p>
                        <DialogTitle className="font-mono text-lg text-[var(--dd-text-primary)]">
                            Port tmux session
                        </DialogTitle>
                        <DialogDescription className="font-mono text-xs text-[var(--dd-text-secondary)]">
                            Session{" "}
                            <span className="rounded-full bg-white/5 px-2 py-0.5 text-[var(--dd-accent-from)]">
                                {tmuxSessionName}
                            </span>
                        </DialogDescription>
                    </DialogHeader>

                    <DoubleBezel>
                        <button
                            type="button"
                            disabled={send.isPending}
                            onClick={() => send.mutate({ mode: "quick_dev_dashboard" })}
                            className="group flex w-full items-center gap-3 px-4 py-4 text-left transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-0.5 active:scale-[0.99]"
                        >
                            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--dd-accent-from)]/15 text-[var(--dd-accent-from)]">
                                <Sparkles size={16} />
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block font-mono text-sm font-semibold text-[var(--dd-text-primary)]">
                                    {DEV_DASHBOARD_WORKSPACE} workspace
                                </span>
                                <span className="block text-[11px] text-[var(--dd-text-muted)]">
                                    New split · canonical handoff target
                                </span>
                            </span>
                            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-px">
                                <ArrowUpRight size={14} />
                            </span>
                        </button>
                    </DoubleBezel>

                    <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--dd-text-muted)]">
                        or choose destination
                    </p>

                    {isLoading ? (
                        <div className="py-8 text-center font-mono text-sm text-[var(--dd-text-muted)]">Loading layout…</div>
                    ) : isError || !layout?.available ? (
                        <div className="py-8 text-center font-mono text-sm text-[#f87171]">
                            {layout?.error ?? "Failed to load cmux layout"}
                        </div>
                    ) : (
                        <CmuxLayoutTreePicker
                            layout={layout}
                            windowId={windowId}
                            workspaceId={workspaceId}
                            paneId={paneId}
                            surfaceId={surfaceId}
                            deliveryMode={deliveryMode}
                            onWindowId={setWindowId}
                            onWorkspaceId={setWorkspaceId}
                            onPaneId={setPaneId}
                            onSurfaceId={setSurfaceId}
                            onDeliveryMode={setDeliveryMode}
                        />
                    )}

                    {send.isError ? (
                        <p className="font-mono text-xs text-[#f87171]">
                            {send.error instanceof Error ? send.error.message : String(send.error)}
                        </p>
                    ) : null}

                    <DialogFooter className="gap-2 sm:justify-end">
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
                    </DialogFooter>
                </div>
            </DialogContent>
        </Dialog>
    );
}
