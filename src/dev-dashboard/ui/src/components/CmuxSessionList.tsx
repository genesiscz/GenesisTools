import type { CmuxSnapshot } from "@app/dev-dashboard/lib/cmux/types";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@ui/components/tooltip";
import { CircleDashed } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Mosaic, type MosaicNode, MosaicWindow } from "react-mosaic-component";
import "react-mosaic-component/react-mosaic-component.css";
import { SemanticTerminalPreview } from "@/components/SemanticTerminalPreview";
import { MobileTerminalShell } from "@/components/terminal-shell/MobileTerminalShell";
import { useLayoutMode } from "@/hooks/useLayoutMode";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cmuxApi } from "@/lib/api";
import {
    buildBalancedMosaicLayout,
    flattenMosaicLeaves,
    pruneMosaicLeaves,
    reconcileMosaicLayout,
} from "@/lib/mosaic-layout";

interface Props {
    snapshot: CmuxSnapshot;
}

const GONE_PANE_GRACE_MS = 5000;

interface GonePaneProps {
    id: string;
    onExpire: (id: string) => void;
}

function GoneCmuxPane({ id, onExpire }: GonePaneProps) {
    useEffect(() => {
        const timeout = window.setTimeout(() => onExpire(id), GONE_PANE_GRACE_MS);

        return () => window.clearTimeout(timeout);
    }, [id, onExpire]);

    return (
        <div className="dd-panel flex h-full items-center justify-center p-2 text-[var(--dd-text-muted)]">
            pane gone
        </div>
    );
}

export function CmuxSessionList({ snapshot }: Props) {
    const workspaceById = useMemo(
        () => new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace])),
        [snapshot.workspaces]
    );
    const panes = useMemo(
        () =>
            snapshot.workspaces.flatMap((workspace) =>
                snapshot.panes.filter((pane) => pane.workspaceId === workspace.id)
            ),
        [snapshot.panes, snapshot.workspaces]
    );
    const paneById = useMemo(() => new Map(panes.map((pane) => [pane.id, pane])), [panes]);
    const paneIdsKey = panes.map((pane) => pane.id).join("\u0000");
    const paneIds = useMemo(() => (paneIdsKey ? paneIdsKey.split("\u0000") : []), [paneIdsKey]);
    const surfaceIdsKey = panes
        .map((pane) => `${pane.id}:${pane.surfaces.map((surface) => surface.id).join(",")}`)
        .join("|");
    const [layout, setLayout] = useState<MosaicNode<string> | null>(null);
    const [surfaceSelectionByPaneId, setSurfaceSelectionByPaneId] = useState<Record<string, string>>({});
    const attach = useMutation({
        mutationFn: (target: { workspaceId: string; paneId: string }) => cmuxApi.attach(target),
    });
    const renameMut = useMutation({
        mutationFn: (body: { workspaceId: string; surfaceId?: string; title: string }) => cmuxApi.rename(body),
        // snapshot poll (2s, in CmuxRoute) reflects the new title — no invalidate.
    });
    const { mode, isMobile, setMode } = useLayoutMode("cmux");
    const [activePaneId, setActivePaneId] = useState<string | null>(null);
    const removeGonePane = useCallback((id: string) => {
        setLayout((current) => pruneMosaicLeaves(current, new Set([id])));
    }, []);

    // Phone-width screens stack panes vertically instead of side by side.
    const isNarrow = useMediaQuery("(max-width: 640px)");
    const mosaicOptions = useMemo(
        () => ({ maxColumns: isNarrow ? 1 : 2, extraRowPlacement: "start" as const }),
        [isNarrow]
    );

    useEffect(() => {
        setLayout((current) => {
            const livePaneIds = new Set(paneIds);
            const gonePaneIds = flattenMosaicLeaves(current).filter((id) => !livePaneIds.has(id));

            return reconcileMosaicLayout(current, [...paneIds, ...gonePaneIds], mosaicOptions);
        });
    }, [paneIdsKey, paneIds, mosaicOptions]);

    useEffect(() => {
        setLayout((current) => {
            const ids = flattenMosaicLeaves(current);
            if (ids.length === 0) {
                return current;
            }

            return buildBalancedMosaicLayout(ids, mosaicOptions);
        });
    }, [mosaicOptions]);

    useEffect(() => {
        setSurfaceSelectionByPaneId((current) => {
            const next: Record<string, string> = {};

            for (const pane of panes) {
                const selectedSurfaceId = current[pane.id];
                if (selectedSurfaceId && pane.surfaces.some((surface) => surface.id === selectedSurfaceId)) {
                    next[pane.id] = selectedSurfaceId;
                }
            }

            const currentKeys = Object.keys(current);
            const nextKeys = Object.keys(next);
            const changed =
                currentKeys.length !== nextKeys.length || currentKeys.some((key) => current[key] !== next[key]);

            return changed ? next : current;
        });
    }, [panes, surfaceIdsKey]);

    if (!snapshot.available) {
        return (
            <div className="dd-panel flex h-full items-center justify-center font-mono text-[var(--dd-text-muted)]">
                <div className="text-center">
                    <p>cmux is not reachable.</p>
                    <p className="mt-1 text-[10px]">{snapshot.error ?? "Start the cmux app to populate this panel."}</p>
                </div>
            </div>
        );
    }

    const surfaceFor = (paneId: string) => {
        const pane = paneById.get(paneId);
        if (!pane) {
            return undefined;
        }

        const list = pane.surfaces ?? [];
        return (
            list.find((surface) => surface.id === surfaceSelectionByPaneId[pane.id]) ??
            list.find((surface) => surface.selected) ??
            list[0]
        );
    };

    if (mode === "focused") {
        const activePane = panes.find((p) => p.id === activePaneId) ?? panes.find((p) => p.active) ?? panes[0] ?? null;
        const activeSurface = activePane ? surfaceFor(activePane.id) : undefined;

        return (
            <div className="dd-focused-host relative h-[100dvh]">
                {!isMobile ? (
                    <div className="absolute right-2 top-1 z-30">
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setMode(mode === "focused" ? "mosaic" : "focused")}
                            aria-label="toggle layout"
                        >
                            Mosaic
                        </Button>
                    </div>
                ) : null}
                {activePane ? (
                    <MobileTerminalShell
                        tabs={panes.map((p) => {
                            const ws = workspaceById.get(p.workspaceId);

                            return {
                                id: p.id,
                                label: ws?.name ? `${ws.name} · ${p.title}` : p.title,
                                active: p.id === activePane.id,
                                dot: p.active ? ("active" as const) : ("idle" as const),
                                lastLine: (surfaceFor(p.id)?.preview ?? p.preview ?? "").split("\n")[0],
                            };
                        })}
                        secondaryTabs={(activePane.surfaces ?? []).map((s) => ({
                            id: s.id,
                            label: s.title,
                            active: s.id === activeSurface?.id,
                        }))}
                        onSelect={setActivePaneId}
                        onSelectSecondary={(surfaceId) =>
                            setSurfaceSelectionByPaneId((current) => ({ ...current, [activePane.id]: surfaceId }))
                        }
                        onRename={(_id, name) => renameMut.mutate({ workspaceId: activePane.workspaceId, title: name })}
                        onRenameSecondary={(surfaceId, name) =>
                            renameMut.mutate({ workspaceId: activePane.workspaceId, surfaceId, title: name })
                        }
                        primaryAction={{
                            label: "attach",
                            onClick: () =>
                                attach.mutate({ workspaceId: activePane.workspaceId, paneId: activePane.id }),
                        }}
                        renderPreview={(paneId) => (
                            <SemanticTerminalPreview
                                preview={
                                    surfaceFor(paneId)?.preview || paneById.get(paneId)?.preview || "(no snapshot text)"
                                }
                            />
                        )}
                    >
                        <div className="absolute inset-0 overflow-hidden p-2 font-mono">
                            <SemanticTerminalPreview
                                preview={activeSurface?.preview || activePane.preview || "(no snapshot text)"}
                            />
                        </div>
                    </MobileTerminalShell>
                ) : (
                    <div className="dd-panel flex h-full items-center justify-center text-[var(--dd-text-muted)]">
                        No cmux panes in the current snapshot.
                    </div>
                )}
            </div>
        );
    }

    return (
        <TooltipProvider>
            <div className="flex h-full flex-col gap-2 overflow-hidden font-mono">
                <div className="dd-panel flex items-center justify-between px-3 py-2 text-[11px] text-[var(--dd-text-muted)]">
                    <span>snapshot · {new Date(snapshot.fetchedAt).toLocaleTimeString()}</span>
                    <span className="flex items-center gap-3">
                        <span>drag panes to reorder · drag dividers to resize · live snapshot</span>
                        {!isMobile ? (
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setMode("focused")}
                                aria-label="toggle layout"
                            >
                                Focused
                            </Button>
                        ) : null}
                    </span>
                </div>
                <div className="min-h-0 flex-1">
                    {layout ? (
                        <Mosaic<string>
                            value={layout}
                            onChange={(next) => setLayout(next)}
                            renderTile={(id, path) => {
                                const pane = paneById.get(id);

                                if (!pane) {
                                    return <GoneCmuxPane id={id} onExpire={removeGonePane} />;
                                }

                                const workspace = workspaceById.get(pane.workspaceId);
                                const surfaces = pane.surfaces ?? [];
                                const nativeSurface = surfaces.find((surface) => surface.selected) ?? surfaces[0];
                                const selectedSurface =
                                    surfaces.find((surface) => surface.id === surfaceSelectionByPaneId[pane.id]) ??
                                    nativeSurface;

                                return (
                                    <MosaicWindow<string>
                                        path={path}
                                        title={`${workspace?.name ?? "cmux"} · ${pane.title}`}
                                        additionalControls={null}
                                        toolbarControls={
                                            <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <Button
                                                        className="h-6 px-2 text-[10px]"
                                                        variant="ghost"
                                                        disabled={attach.isPending}
                                                        onClick={() =>
                                                            attach.mutate({
                                                                workspaceId: pane.workspaceId,
                                                                paneId: pane.id,
                                                            })
                                                        }
                                                        aria-label={`focus ${pane.title} in cmux`}
                                                    >
                                                        <CircleDashed size={11} /> attach
                                                    </Button>
                                                </TooltipTrigger>
                                                <TooltipContent>Focus this pane in the native cmux app.</TooltipContent>
                                            </Tooltip>
                                        }
                                    >
                                        <div className="dd-cmux-tile flex h-full flex-col overflow-hidden p-2">
                                            <div className="dd-cmux-meta mb-2 flex min-w-0 items-center gap-2">
                                                <span
                                                    className="inline-block h-[7px] w-[7px] shrink-0 rounded-full"
                                                    style={
                                                        pane.active
                                                            ? {
                                                                  background: "var(--dd-accent-from)",
                                                                  boxShadow: "0 0 8px var(--dd-accent-from)",
                                                              }
                                                            : { background: "#2a3439" }
                                                    }
                                                />
                                                <span className="truncate text-[var(--dd-text-secondary)]">
                                                    {pane.cwd ?? pane.title}
                                                </span>
                                                <span className="ml-auto shrink-0 text-[var(--dd-text-muted)]">
                                                    {pane.surfaceCount ?? surfaces.length} tabs
                                                </span>
                                            </div>
                                            <div className="dd-cmux-tabs mb-2">
                                                {surfaces.map((surface) => (
                                                    <button
                                                        key={surface.id}
                                                        type="button"
                                                        className={[
                                                            "dd-cmux-tab",
                                                            surface.selected ? "is-selected" : "",
                                                            surface.id === selectedSurface?.id ? "is-viewed" : "",
                                                        ]
                                                            .filter(Boolean)
                                                            .join(" ")}
                                                        onClick={() =>
                                                            setSurfaceSelectionByPaneId((current) => ({
                                                                ...current,
                                                                [pane.id]: surface.id,
                                                            }))
                                                        }
                                                        title={surface.title}
                                                        aria-pressed={surface.id === selectedSurface?.id}
                                                    >
                                                        <span className="truncate">{surface.title}</span>
                                                    </button>
                                                ))}
                                            </div>
                                            <SemanticTerminalPreview
                                                preview={
                                                    selectedSurface?.preview || pane.preview || "(no snapshot text)"
                                                }
                                            />
                                        </div>
                                    </MosaicWindow>
                                );
                            }}
                            className="dd-mosaic"
                        />
                    ) : (
                        <div className="dd-panel flex h-full items-center justify-center text-[var(--dd-text-muted)]">
                            No cmux panes in the current snapshot.
                        </div>
                    )}
                </div>
            </div>
        </TooltipProvider>
    );
}
