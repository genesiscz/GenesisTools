import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Mosaic, type MosaicNode, MosaicWindow } from "react-mosaic-component";
import "react-mosaic-component/react-mosaic-component.css";
import { Button } from "@ui/components/button";
import { TtydPane } from "@/components/TtydPane";
import { MobileTerminalShell } from "@/components/terminal-shell/MobileTerminalShell";
import { useLayoutMode } from "@/hooks/useLayoutMode";
import { ttydApi } from "@/lib/api";
import { buildBalancedMosaicLayout, flattenMosaicLeaves, reconcileMosaicLayout } from "@/lib/mosaic-layout";
import { buildTtydTabs } from "@/lib/terminal-tabs";

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
    const { data } = useQuery({ queryKey: ["ttyd", "list"], queryFn: ttydApi.list });
    const sessions = data?.sessions ?? [];
    const [layout, setLayout] = useState<MosaicNode<string> | null>(null);
    const { mode, isMobile, setMode } = useLayoutMode("ttyd");
    const [activeId, setActiveId] = useState<string | null>(null);
    const active = activeId ?? sessions[0]?.id ?? null;

    // Mosaic layout maths (desktop-mosaic only). Hooks stay unconditional;
    // the computed `layout` is simply unused in focused mode.
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

    const spawn = useMutation({
        mutationFn: () => ttydApi.spawn(),
        onSuccess: (data) => {
            queryClient.invalidateQueries({ queryKey: ["ttyd", "list"] });
            // Focus the freshly-spawned terminal (＋ / "New terminal") instead
            // of leaving the view on the previously-active tab.
            if (data?.session?.id) {
                setActiveId(data.session.id);
            }
        },
    });

    const kill = useMutation({
        mutationFn: (id: string) => ttydApi.kill(id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["ttyd", "list"] });
        },
    });

    const renameMut = useMutation({
        mutationFn: ({ id, name }: { id: string; name: string }) => ttydApi.rename(id, name),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["ttyd", "list"] });
        },
    });

    if (mode === "focused") {
        return (
            <div className="dd-focused-host relative h-[100dvh]">
                {!isMobile ? (
                    <div className="absolute right-2 top-1 z-30">
                        <LayoutToggle mode={mode} setMode={setMode} />
                    </div>
                ) : null}
                {sessions.length > 0 ? (
                    <MobileTerminalShell
                        tabs={buildTtydTabs(sessions, active).map((t) => ({ ...t, dot: "active" as const }))}
                        onSelect={setActiveId}
                        onRename={(id, name) => renameMut.mutate({ id, name })}
                        primaryAction={{ label: "＋", onClick: () => spawn.mutate() }}
                        renderPreview={(id) => {
                            const s = sessions.find((x) => x.id === id);

                            return s ? (
                                <iframe
                                    src={`/ttyd/${encodeURIComponent(s.id)}/`}
                                    title={`ttyd-prev-${id}`}
                                    className="h-full w-full border-0 bg-black"
                                />
                            ) : null;
                        }}
                    >
                        {sessions.map((s) => (
                            // Every iframe stays mounted AND full-size (never display:none — that
                            // collapses ttyd's xterm fit to ~0 and it never recovers). Toggle
                            // visibility with opacity/z-index so the websocket + correct fit survive.
                            <div
                                key={s.id}
                                className="absolute inset-0"
                                style={{
                                    opacity: s.id === active ? 1 : 0,
                                    pointerEvents: s.id === active ? "auto" : "none",
                                    zIndex: s.id === active ? 1 : 0,
                                }}
                            >
                                <iframe
                                    src={`/ttyd/${encodeURIComponent(s.id)}/`}
                                    title={`ttyd-${s.id}`}
                                    className="h-full w-full border-0 bg-black"
                                />
                            </div>
                        ))}
                    </MobileTerminalShell>
                ) : (
                    <div className="dd-panel flex h-full items-center justify-center text-[var(--dd-text-muted)]">
                        No terminals — tap ＋ to start one.
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="flex h-[calc(100vh-2rem)] flex-col gap-2">
            <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => spawn.mutate()} disabled={spawn.isPending}>
                    <Plus size={14} /> New terminal
                </Button>
                <span className="text-[11px] font-mono text-[var(--dd-text-muted)]">
                    drag dividers to resize · close a window to kill the session
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
                                    title={`${session.command.split("/").pop()} :${session.port}`}
                                    additionalControls={null}
                                    toolbarControls={
                                        <Button
                                            size="icon-sm"
                                            variant="ghost"
                                            onClick={() => kill.mutate(session.id)}
                                            aria-label="close terminal"
                                        >
                                            <X size={12} />
                                        </Button>
                                    }
                                >
                                    <TtydPane session={session} />
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
        </div>
    );
}
