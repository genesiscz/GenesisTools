import { ttydLabel } from "@app/dev-dashboard/lib/ttyd/label";
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";
import {
    buildBalancedMosaicLayout,
    flattenMosaicLeaves,
    reconcileMosaicLayout,
} from "@genesiscz/utils/ui/helpers/mosaic-layout";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { BlinkingBox } from "@ui/components/BlinkingBox";
import { Button } from "@ui/components/button";
import { IconButton } from "@ui/components/icon-button";
import { cn } from "@ui/lib/utils";
import { Layers, Plus, Send, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { MosaicNode } from "react-mosaic-component";
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
import { invalidateTmuxAndTtyd } from "@/lib/query-keys";
import { buildTtydTabs } from "@/lib/terminal-tabs";
import { pickTtydActiveId, TTYD_TAB_SEARCH_KEY, writeTtydActiveId } from "@/lib/view-state";

const loadTtydMosaic = () => import("@/components/TtydMosaic");
const TtydMosaic = lazy(() => loadTtydMosaic().then((module) => ({ default: module.TtydMosaic })));

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
    const sessions = data?.sessions ?? [];
    const [layout, setLayout] = useState<MosaicNode<string> | null>(null);
    const { mode, isMobile, setMode } = useLayoutMode("ttyd");
    // Only the mosaic tile's "Send to cmux" tint reads this, and `inCmux` comes from the slow
    // cmux query. The fast list therefore loads once (and again when a spawn, kill or rename
    // invalidates it) instead of polling every 5 s, and focused mode does not fetch at all.
    const { sessions: tmuxHub } = useTmuxHubSessions({ enabled: mode === "mosaic", listIntervalMs: false });

    const isSessionInCmux = (tmuxSessionName: string) =>
        tmuxHub.some((session) => session.name === tmuxSessionName && session.inCmux);
    const focusedMobile = mode === "focused" && isMobile;
    useLockPageScroll(mode === "focused");
    useVisualViewportSize(focusedMobile);
    const [activeId, setActiveId] = useState<string | null>(null);
    const active = activeId ?? sessions[0]?.id ?? null;
    // Focused mode stacks every terminal and shows one. Each iframe is a whole ttyd page
    // (about 720 KB), an xterm and a tmux client, so a terminal now connects the first time
    // it is shown instead of all of them at page open. A shown one stays mounted, so
    // switching back to it is still instant.
    const [shownIds, setShownIds] = useState<ReadonlySet<string>>(() => new Set());

    useEffect(() => {
        if (active && !shownIds.has(active)) {
            setShownIds((current) => new Set(current).add(active));
        }
    }, [active, shownIds]);

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

        // Fetch the mosaic chunk beside the terminal list instead of after it.
        void loadTtydMosaic();

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
            invalidateTmuxAndTtyd(queryClient);
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
                                <BlinkingBox
                                    key={s.id}
                                    active={highlightId === s.id}
                                    variant="accent-glow"
                                    iterations={1}
                                    durationMs={2500}
                                    className={cn(
                                        "absolute inset-0 min-w-0 overflow-hidden",
                                        highlightId === s.id ? "dd-ttyd-highlight" : undefined
                                    )}
                                    style={{
                                        opacity: s.id === active ? 1 : 0,
                                        pointerEvents: s.id === active ? "auto" : "none",
                                        zIndex: s.id === active ? 1 : 0,
                                    }}
                                >
                                    {s.id === active || shownIds.has(s.id) ? (
                                        <TtydFrame
                                            id={s.id}
                                            title={`ttyd-${s.id}`}
                                            className="h-full w-full bg-black"
                                            iframeRef={s.id === active ? activeIframeRef : undefined}
                                        />
                                    ) : null}
                                    {s.id === active ? <TtydScrollPads iframeRef={activeIframeRef} /> : null}
                                    {s.id === active ? (
                                        <TtydScrollbar ttydId={active} iframeRef={activeIframeRef} />
                                    ) : null}
                                </BlinkingBox>
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
                    <Suspense fallback={null}>
                        <TtydMosaic
                            layout={layout}
                            onChange={(next) => setLayout(next)}
                            sessions={sessions}
                            renderToolbar={(session) => (
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
                            )}
                            renderBody={(session) => (
                                <BlinkingBox
                                    active={highlightId === session.id}
                                    variant="accent-glow"
                                    iterations={1}
                                    durationMs={2500}
                                    className={cn(
                                        "h-full",
                                        highlightId === session.id ? "dd-ttyd-highlight" : undefined
                                    )}
                                >
                                    <TtydPane session={session} />
                                </BlinkingBox>
                            )}
                        />
                    </Suspense>
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
