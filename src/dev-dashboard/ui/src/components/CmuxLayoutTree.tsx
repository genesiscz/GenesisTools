import type { CmuxLayoutTree } from "@app/dev-dashboard/lib/cmux/types";
import type { ReactNode } from "react";
import { SemanticTerminalPreview } from "@/components/SemanticTerminalPreview";

type DeliveryMode = "new_split" | "new_surface" | "existing_surface";

interface Props {
    layout: CmuxLayoutTree;
    windowId: string | null;
    workspaceId: string | null;
    paneId: string | null;
    surfaceId: string | null;
    deliveryMode: DeliveryMode;
    onWindowId: (id: string) => void;
    onWorkspaceId: (id: string) => void;
    onPaneId: (id: string) => void;
    onSurfaceId: (id: string) => void;
    onDeliveryMode: (mode: DeliveryMode) => void;
}

function Column({
    title,
    children,
    delayMs,
}: {
    title: string;
    children: ReactNode;
    delayMs: number;
}) {
    return (
        <div
            className="min-h-[200px] flex-1 animate-in fade-in slide-in-from-bottom-3 fill-mode-both duration-700"
            style={{ animationDelay: `${delayMs}ms` }}
        >
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--dd-text-muted)]">{title}</p>
            <div className="rounded-[1rem] bg-white/5 p-1 ring-1 ring-white/10">
                <div className="max-h-52 space-y-1 overflow-y-auto rounded-[calc(1rem-0.25rem)] bg-[var(--dd-bg-elevated)] p-1.5">
                    {children}
                </div>
            </div>
        </div>
    );
}

function PickButton({
    active,
    disabled,
    onClick,
    children,
}: {
    active: boolean;
    disabled?: boolean;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className={[
                "block w-full rounded-lg px-2 py-1.5 text-left font-mono text-[11px] transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
                "active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40",
                active
                    ? "bg-[var(--dd-accent-from)]/15 text-[var(--dd-accent-from)] ring-1 ring-[var(--dd-accent-from)]/40"
                    : "text-[var(--dd-text-secondary)] hover:bg-white/5 hover:text-[var(--dd-text-primary)]",
            ].join(" ")}
        >
            {children}
        </button>
    );
}

export function CmuxLayoutTreePicker({
    layout,
    windowId,
    workspaceId,
    paneId,
    surfaceId,
    deliveryMode,
    onWindowId,
    onWorkspaceId,
    onPaneId,
    onSurfaceId,
    onDeliveryMode,
}: Props) {
    const selectedWindow = layout.windows.find((window) => window.id === windowId) ?? layout.windows[0] ?? null;
    const workspaces = selectedWindow?.workspaces ?? [];
    const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
    const panes = selectedWorkspace?.panes ?? [];
    const selectedPane = panes.find((pane) => pane.id === paneId) ?? null;
    const surfaces = selectedPane?.surfaces ?? [];
    const selectedSurface =
        surfaces.find((surface) => surface.id === surfaceId) ??
        surfaces.find((surface) => surface.selected) ??
        surfaces[0] ??
        null;

    const preview =
        selectedSurface?.preview ??
        selectedPane?.surfaces.find((surface) => surface.selected)?.preview ??
        selectedPane?.surfaces[0]?.preview;

    return (
        <div className="space-y-3">
            <div className="flex flex-col gap-3 md:flex-row">
                <Column title="Window" delayMs={0}>
                    {layout.windows.map((window) => (
                        <PickButton
                            key={window.id}
                            active={selectedWindow?.id === window.id}
                            onClick={() => {
                                onWindowId(window.id);
                                onWorkspaceId("");
                                onPaneId("");
                                onSurfaceId("");
                            }}
                        >
                            window {window.index}
                            {!window.visible ? " · hidden" : ""}
                        </PickButton>
                    ))}
                </Column>

                <Column title="Workspace" delayMs={80}>
                    {workspaces.map((workspace) => (
                        <PickButton
                            key={workspace.id}
                            active={selectedWorkspace?.id === workspace.id}
                            onClick={() => {
                                onWorkspaceId(workspace.id);
                                onPaneId("");
                                onSurfaceId("");
                            }}
                        >
                            {workspace.name}
                            {workspace.selected ? " · active" : ""}
                        </PickButton>
                    ))}
                </Column>

                <Column title="Pane" delayMs={160}>
                    {panes.map((pane) => (
                        <PickButton
                            key={pane.id}
                            active={selectedPane?.id === pane.id}
                            onClick={() => {
                                onPaneId(pane.id);
                                onSurfaceId("");
                            }}
                        >
                            {pane.title}
                            {pane.active ? " · focused" : ""}
                        </PickButton>
                    ))}
                </Column>

                <Column title="Terminal" delayMs={240}>
                    {surfaces.map((surface) => (
                        <PickButton
                            key={surface.id}
                            active={selectedSurface?.id === surface.id}
                            disabled={surface.type !== "terminal"}
                            onClick={() => onSurfaceId(surface.id)}
                        >
                            {surface.title}
                            {surface.type !== "terminal" ? ` · ${surface.type}` : ""}
                        </PickButton>
                    ))}
                </Column>
            </div>

            {selectedWorkspace ? (
                <div className="flex flex-wrap gap-2">
                    {(
                        [
                            ["new_split", "New panel split"],
                            ["new_surface", "New tab in pane"],
                            ["existing_surface", "Use this terminal"],
                        ] as const
                    ).map(([mode, label]) => (
                        <button
                            key={mode}
                            type="button"
                            onClick={() => onDeliveryMode(mode)}
                            className={[
                                "rounded-full px-3 py-1 font-mono text-[10px] uppercase tracking-[0.15em] transition-all duration-300",
                                deliveryMode === mode
                                    ? "bg-[var(--dd-accent-from)]/20 text-[var(--dd-accent-from)] ring-1 ring-[var(--dd-accent-from)]/40"
                                    : "bg-white/5 text-[var(--dd-text-muted)] hover:bg-white/10",
                            ].join(" ")}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            ) : null}

            {preview ? (
                <div className="rounded-[1rem] bg-white/5 p-1 ring-1 ring-white/10">
                    <div className="max-h-36 overflow-hidden rounded-[calc(1rem-0.25rem)] bg-black/40 p-2">
                        <SemanticTerminalPreview preview={preview} />
                    </div>
                </div>
            ) : null}
        </div>
    );
}
