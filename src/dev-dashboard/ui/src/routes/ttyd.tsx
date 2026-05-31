import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Layers, Plus, Send, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Mosaic, type MosaicNode, MosaicWindow } from "react-mosaic-component";
import "react-mosaic-component/react-mosaic-component.css";
import { ttydLabel } from "@app/dev-dashboard/lib/ttyd/label";
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";
import {
    buildBalancedMosaicLayout,
    flattenMosaicLeaves,
    reconcileMosaicLayout,
} from "@app/utils/ui/helpers/mosaic-layout";
import { Button } from "@ui/components/button";
import { IconButton } from "@ui/components/icon-button";
import { CmuxSendTargetDialog } from "@/components/CmuxSendTargetDialog";
import { MobileKeyBar } from "@/components/MobileKeyBar";
import { TmuxSessionsPanel } from "@/components/TmuxSessionsPanel";
import { TtydCloseDialog } from "@/components/TtydCloseDialog";
import { TtydFrame } from "@/components/TtydFrame";
import { TtydPane } from "@/components/TtydPane";
import { TtydPasteDialog } from "@/components/TtydPasteDialog";
import { TtydScrollbar } from "@/components/TtydScrollbar";
import { TtydScrollPads } from "@/components/TtydScrollPads";
import { MobileTerminalShell } from "@/components/terminal-shell/MobileTerminalShell";
import { ShellIconButton } from "@/components/terminal-shell/ShellIconButton";
import { useLayoutMode } from "@/hooks/useLayoutMode";
import { useLockPageScroll } from "@/hooks/useLockPageScroll";
import { useTmuxHubSessions } from "@/hooks/useTmuxHubSessions";
import { useVisualViewportSize } from "@/hooks/useVisualViewportSize";
import { ttydApi } from "@/lib/api";
import {
    pasteTextToIframe,
    scrollIframeTerminal,
    scrollIframeTerminalByPage,
    sendKeyToIframe,
} from "@/lib/iframe-keys";
import { buildTtydTabs } from "@/lib/terminal-tabs";
import { pickTtydActiveId, TTYD_TAB_SEARCH_KEY, writeTtydActiveId } from "@/lib/view-state";

function LayoutToggle({ mode, setMode }: { mode: "mosaic" | "focused"; setMode: (m: "mosaic" | "focused") => void }) {
    return (
        <Button
            size="sm"
            variant="outline"
            onClick={() => setMode(mode === "mosaic" ? "focused" : "mosaic")}
            aria-label="toggle layout"
        >
            {mode === "mosaic" ? "Focused" : "Mosaic"}
        </Button>
    );
}

export function TtydRoute() {
    const queryClient = useQueryClient();
    const navigate = useNavigate({ from: "/ttyd" });
    const { tab: urlTabId } = useSearch({ from: "/ttyd" });
    const { data } = useQuery({ queryKey: ["ttyd", "list"], queryFn: ttydApi.list });
    const { sessions: tmuxHub } = useTmuxHubSessions({ listIntervalMs: 5000 });
    const sessions = data?.sessions ?? [];

    const isSessionInCmux = (tmuxSessionName: string) =>
        tmuxHub.some((session) => session.name === tmuxSessionName && session.inCmux);
    const [layout, setLayout] = useState<MosaicNode<string> | null>(null);
    const { mode, isMobile, setMode } = useLayoutMode("ttyd");
    const focusedMobile = mode === "focused" && isMobile;
    useLockPageScroll(mode === "focused");
    useVisualViewportSize(focusedMobile);
    const [activeId, setActiveId] = useState<string | null>(null);
    const active = activeId ?? sessions[0]?.id ?? null;
    const [hubOpen, setHubOpen] = useState(false);
    const [closeTarget, setCloseTarget] = useState<TtydSession | null>(null);
    const [sendTarget, setSendTarget] = useState<TtydSession | null>(null);
    const [highlightId, setHighlightId] = useState<string | null>(null);
    const [pasteDialogOpen, setPasteDialogOpen] = useState(false);
    const activeIframeRef = useRef<HTMLIFrameElement | null>(null);
    const pendingFocusTtydIdRef = useRef<string | null>(null);

    // Open the paste dialog synchronously in the tap. The dialog owns the
    // clipboard read (a real in-gesture button there is the only path iOS honours)
    // and the manual-paste textarea; desktop also has native ⌘V via the iframe.
    const openPasteDialog = useCallback(() => {
        setPasteDialogOpen(true);
    }, []);

    const focusTtydTab = useCallback(
        (ttydId: string) => {
            pendingFocusTtydIdRef.current = ttydId;
            setActiveId(ttydId);
            writeTtydActiveId(ttydId);
            setHighlightId(ttydId);
            window.setTimeout(() => setHighlightId(null), 2500);
            navigate({ search: { [TTYD_TAB_SEARCH_KEY]: ttydId }, replace: true });
        },
        [navigate]
    );

    useEffect(() => {
        if (sessions.length === 0) {
            return;
        }

        setActiveId((current) => {
            if (current && sessions.some((session) => session.id === current)) {
                if (pendingFocusTtydIdRef.current === current) {
                    pendingFocusTtydIdRef.current = null;
                }

                return current;
            }

            if (current && current === pendingFocusTtydIdRef.current) {
                return current;
            }

            return pickTtydActiveId({
                sessionIds: sessions.map((session) => session.id),
                urlTabId,
            });
        });
    }, [sessions, urlTabId]);

    useEffect(() => {
        if (!activeId) {
            return;
        }

        writeTtydActiveId(activeId);

        if (urlTabId !== activeId) {
            navigate({ search: { [TTYD_TAB_SEARCH_KEY]: activeId }, replace: true });
        }
    }, [activeId, navigate, urlTabId]);

    const maxColumns = 3;

    useEffect(() => {
        setLayout((current) =>
            reconcileMosaicLayout(
                current,
                sessions.map((session) => session.id),
                { maxColumns }
            )
        );
    }, [sessions]);

    useEffect(() => {
        setLayout((current) => {
            const ids = flattenMosaicLeaves(current);
            if (ids.length === 0) {
                return current;
            }

            return buildBalancedMosaicLayout(ids, { maxColumns });
        });
    }, []);

    useEffect(() => {
        if (mode !== "mosaic") {
            return;
        }

        // Nudge react-mosaic to recompute once after the container paints. A
        // persistent "resize" listener that re-dispatches "resize" recurses
        // infinitely on a real resize — react-mosaic already listens to window
        // resizes itself, so a single post-paint nudge on mode switch is enough.
        const rafId = window.requestAnimationFrame(() => {
            window.dispatchEvent(new Event("resize"));
        });

        return () => window.cancelAnimationFrame(rafId);
    }, [mode]);

    const spawn = useMutation({
        mutationFn: () => ttydApi.spawn(),
        onSuccess: (data) => {
            queryClient.invalidateQueries({ queryKey: ["ttyd", "list"] });
            queryClient.invalidateQueries({ queryKey: ["tmux"] });

            if (data?.session?.id) {
                focusTtydTab(data.session.id);
            }
        },
    });

    const kill = useMutation({
        mutationFn: ({ id, killTmux }: { id: string; killTmux: boolean }) => ttydApi.kill(id, killTmux),
        onSuccess: (_, { id: killedId }) => {
            queryClient.invalidateQueries({ queryKey: ["ttyd", "list"] });
            queryClient.invalidateQueries({ queryKey: ["tmux"] });
            setCloseTarget(null);
            setActiveId((current) => (current === killedId ? null : current));
        },
    });

    const renameMut = useMutation({
        mutationFn: ({ id, name }: { id: string; name: string }) => ttydApi.rename(id, name),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["ttyd", "list"] });
        },
    });

    const toolbar = (
        <>
            <Button
                size="sm"
                variant="outline"
                onClick={() => {
                    spawn.mutate();
                }}
                disabled={spawn.isPending}
            >
                <Plus size={14} /> New terminal
            </Button>
            <Button size="sm" variant="outline" onClick={() => setHubOpen(true)} aria-label="Tmux sessions">
                <Layers size={14} />
                <span className="hidden md:inline">Tmux sessions</span>
            </Button>
        </>
    );

    const overlays = (
        <>
            <TtydPasteDialog
                open={pasteDialogOpen}
                onOpenChange={setPasteDialogOpen}
                onSubmit={(text) => pasteTextToIframe(activeIframeRef.current, text)}
            />
            <TmuxSessionsPanel
                open={hubOpen}
                onOpenChange={setHubOpen}
                onFocusTtydTab={(ttydId) => {
                    focusTtydTab(ttydId);
                }}
            />
            {closeTarget ? (
                <TtydCloseDialog
                    open
                    sessionLabel={ttydLabel(closeTarget)}
                    pending={kill.isPending}
                    onOpenChange={(open) => {
                        if (!open) {
                            setCloseTarget(null);
                        }
                    }}
                    onKeep={() => kill.mutate({ id: closeTarget.id, killTmux: false })}
                    onKill={() => kill.mutate({ id: closeTarget.id, killTmux: true })}
                />
            ) : null}
            {sendTarget?.tmuxSessionName ? (
                <CmuxSendTargetDialog
                    open
                    tmuxSessionName={sendTarget.tmuxSessionName}
                    onOpenChange={(open) => {
                        if (!open) {
                            setSendTarget(null);
                        }
                    }}
                    onSent={() => {
                        queryClient.invalidateQueries({ queryKey: ["cmux"] });
                        queryClient.invalidateQueries({ queryKey: ["tmux"] });
                        setSendTarget(null);
                    }}
                />
            ) : null}
        </>
    );

    if (mode === "focused") {
        return (
            <div className="dd-focused-host dd-ttyd-focused relative flex min-h-0 flex-col overflow-hidden">
                <div className="min-h-0 flex-1 overflow-hidden">
                    <MobileTerminalShell
                        tabs={buildTtydTabs(sessions, active).map((t) => ({ ...t, dot: "active" as const }))}
                        onSelect={(id) => {
                            focusTtydTab(id);
                        }}
                        onRename={(id, name) => renameMut.mutate({ id, name })}
                        headerActions={
                            <>
                                {!isMobile ? <LayoutToggle mode={mode} setMode={setMode} /> : null}
                                <ShellIconButton icon={Layers} label="Tmux sessions" onClick={() => setHubOpen(true)} />
                                {active ? (
                                    <ShellIconButton
                                        icon={X}
                                        label="Close terminal"
                                        variant="destructive"
                                        onClick={() => {
                                            const session = sessions.find((candidate) => candidate.id === active);

                                            if (session) {
                                                setCloseTarget(session);
                                            }
                                        }}
                                    />
                                ) : null}
                            </>
                        }
                        primaryAction={{
                            label: "＋",
                            onClick: () => {
                                spawn.mutate();
                            },
                        }}
                        renderPreview={(id) => {
                            const s = sessions.find((x) => x.id === id);

                            return s ? (
                                <TtydFrame
                                    id={s.id}
                                    title={`ttyd-prev-${id}`}
                                    className="h-full w-full border-0 bg-black"
                                />
                            ) : null;
                        }}
                    >
                        {sessions.length > 0 ? (
                            sessions.map((s) => (
                                <div
                                    key={s.id}
                                    className={
                                        highlightId === s.id
                                            ? "dd-ttyd-highlight dd-ttyd-highlight--pulse absolute inset-0 min-w-0 overflow-hidden"
                                            : "absolute inset-0 min-w-0 overflow-hidden"
                                    }
                                    style={{
                                        opacity: s.id === active ? 1 : 0,
                                        pointerEvents: s.id === active ? "auto" : "none",
                                        zIndex: s.id === active ? 1 : 0,
                                    }}
                                >
                                    <TtydFrame
                                        id={s.id}
                                        title={`ttyd-${s.id}`}
                                        className="h-full w-full bg-black"
                                        iframeRef={s.id === active ? activeIframeRef : undefined}
                                    />
                                    {s.id === active ? <TtydScrollPads iframeRef={activeIframeRef} /> : null}
                                    {s.id === active ? (
                                        <TtydScrollbar ttydId={active} iframeRef={activeIframeRef} />
                                    ) : null}
                                </div>
                            ))
                        ) : (
                            <div className="flex h-full items-center justify-center text-[var(--dd-text-muted)]">
                                No terminals — tap ＋ to start one.
                            </div>
                        )}
                    </MobileTerminalShell>
                </div>
                {focusedMobile && active ? (
                    <MobileKeyBar
                        embedded
                        onKey={(key) => sendKeyToIframe(activeIframeRef.current, key)}
                        onScroll={(lines) => scrollIframeTerminal(activeIframeRef.current, lines)}
                        onPageScroll={(direction) => scrollIframeTerminalByPage(activeIframeRef.current, direction)}
                        onPaste={openPasteDialog}
                    />
                ) : null}
                {overlays}
            </div>
        );
    }

    return (
        <div className="flex h-[calc(100vh-2rem)] flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
                {toolbar}
                <span className="text-[11px] font-mono text-[var(--dd-text-muted)]">
                    drag dividers to resize · close asks keep or kill tmux
                </span>
                {!isMobile ? (
                    <span className="ml-auto">
                        <LayoutToggle mode={mode} setMode={setMode} />
                    </span>
                ) : null}
            </div>
            <div className="flex-1 overflow-hidden">
                {layout && sessions.length > 0 ? (
                    <Mosaic<string>
                        value={layout}
                        onChange={(next) => setLayout(next)}
                        renderTile={(id, path) => {
                            const session = sessions.find((candidate) => candidate.id === id);

                            if (!session) {
                                return (
                                    <div className="dd-panel flex h-full items-center justify-center p-2 text-[var(--dd-text-muted)]">
                                        session gone
                                    </div>
                                );
                            }

                            return (
                                <MosaicWindow<string>
                                    path={path}
                                    title={ttydLabel(session)}
                                    additionalControls={null}
                                    toolbarControls={
                                        <div className="flex items-center gap-0.5">
                                            {session.tmuxSessionName ? (
                                                <IconButton
                                                    size="icon-sm"
                                                    variant="ghost"
                                                    tooltip="Send to cmux"
                                                    onClick={() => setSendTarget(session)}
                                                    className={
                                                        isSessionInCmux(session.tmuxSessionName)
                                                            ? "text-muted-foreground hover:bg-accent hover:text-foreground"
                                                            : "text-emerald-400 hover:bg-emerald-400/10 hover:text-emerald-300"
                                                    }
                                                >
                                                    <Send size={12} />
                                                </IconButton>
                                            ) : null}
                                            <IconButton
                                                size="icon-sm"
                                                variant="ghost"
                                                tooltip="Close terminal"
                                                className="text-[var(--dd-danger)] hover:bg-[var(--dd-danger)]/15 hover:text-[var(--dd-danger)]"
                                                onClick={() => setCloseTarget(session)}
                                            >
                                                <X size={12} />
                                            </IconButton>
                                        </div>
                                    }
                                >
                                    <div
                                        className={
                                            highlightId === id
                                                ? "dd-ttyd-highlight dd-ttyd-highlight--pulse h-full"
                                                : "h-full"
                                        }
                                    >
                                        <TtydPane session={session} />
                                    </div>
                                </MosaicWindow>
                            );
                        }}
                        className="dd-mosaic"
                    />
                ) : (
                    <div className="dd-panel flex h-full items-center justify-center text-[var(--dd-text-muted)]">
                        No terminals. Click "New terminal".
                    </div>
                )}
            </div>
            {overlays}
        </div>
    );
}
