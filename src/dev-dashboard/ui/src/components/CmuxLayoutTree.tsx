import type { CmuxLayoutTree } from "@app/dev-dashboard/lib/cmux/types";
import { BezelCard } from "@ui/components/bezel-card";
import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { SemanticTerminalPreview } from "@/components/SemanticTerminalPreview";

export type CmuxPickKind = "new_split" | "new_surface" | "existing_surface";

interface Props {
    layout: CmuxLayoutTree;
    windowId: string | null;
    workspaceId: string | null;
    paneId: string | null;
    surfaceId: string | null;
    pickKind: CmuxPickKind | null;
    creatingWorkspace?: boolean;
    onWindowId: (id: string) => void;
    onWorkspaceId: (id: string) => void;
    onPaneId: (id: string) => void;
    onSurfaceId: (id: string) => void;
    onPickKind: (kind: CmuxPickKind | null) => void;
    onCreateWorkspace?: () => void;
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
            className="flex min-h-[280px] flex-1 flex-col animate-in fade-in slide-in-from-bottom-3 fill-mode-both duration-700"
            style={{ animationDelay: `${delayMs}ms` }}
        >
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">{title}</p>
            <BezelCard className="flex min-h-0 flex-1 flex-col" innerClassName="flex min-h-0 flex-1 flex-col p-1.5">
                <div className="h-64 space-y-1 overflow-y-auto">{children}</div>
            </BezelCard>
        </div>
    );
}

function PickButton({
    active,
    disabled,
    onClick,
    children,
    accent,
}: {
    active: boolean;
    disabled?: boolean;
    onClick: () => void;
    children: ReactNode;
    accent?: boolean;
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
                    : accent
                      ? "text-[var(--dd-accent-from)]/80 hover:bg-[var(--dd-accent-from)]/10 hover:text-[var(--dd-accent-from)]"
                      : "text-[var(--dd-text-secondary)] hover:bg-white/5 hover:text-[var(--dd-text-primary)]",
            ].join(" ")}
        >
            {children}
        </button>
    );
}

function PlusPickButton({
    active,
    disabled,
    label,
    onClick,
}: {
    active: boolean;
    disabled?: boolean;
    label: string;
    onClick: () => void;
}) {
    return (
        <PickButton active={active} disabled={disabled} accent onClick={onClick}>
            <span className="inline-flex items-center gap-1.5">
                <Plus size={12} className="shrink-0" />
                {label}
            </span>
        </PickButton>
    );
}

export function CmuxLayoutTreePicker({
    layout,
    windowId,
    workspaceId,
    paneId,
    surfaceId,
    pickKind,
    creatingWorkspace,
    onWindowId,
    onWorkspaceId,
    onPaneId,
    onSurfaceId,
    onPickKind,
    onCreateWorkspace,
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
        null;

    const preview =
        selectedSurface?.preview ??
        selectedPane?.surfaces.find((surface) => surface.selected)?.preview ??
        selectedPane?.surfaces[0]?.preview ??
        panes.find((pane) => pane.active)?.surfaces.find((surface) => surface.selected)?.preview ??
        panes[0]?.surfaces[0]?.preview;

    const newSplitActive = pickKind === "new_split";
    const newSurfaceActive = pickKind === "new_surface";
    const existingSurfaceActive = pickKind === "existing_surface";

    return (
        <div className="flex h-full min-h-[280px] flex-col gap-3">
            <div className="flex min-h-[280px] flex-1 flex-col gap-3 md:flex-row">
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
                                onPickKind(null);
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
                                onPickKind(null);
                            }}
                        >
                            {workspace.name}
                            {workspace.selected ? " · active" : ""}
                        </PickButton>
                    ))}
                    {selectedWindow && onCreateWorkspace ? (
                        <PlusPickButton
                            active={false}
                            disabled={creatingWorkspace}
                            label={creatingWorkspace ? "Creating…" : "New workspace"}
                            onClick={onCreateWorkspace}
                        />
                    ) : null}
                </Column>

                <Column title="Pane" delayMs={160}>
                    {selectedWorkspace ? (
                        <>
                            {panes.map((pane) => (
                                <PickButton
                                    key={pane.id}
                                    active={selectedPane?.id === pane.id && !newSplitActive}
                                    onClick={() => {
                                        onPaneId(pane.id);
                                        onSurfaceId("");
                                        onPickKind(null);
                                    }}
                                >
                                    {pane.title}
                                    {pane.active ? " · focused" : ""}
                                </PickButton>
                            ))}
                            <PlusPickButton
                                active={newSplitActive}
                                label="New pane"
                                onClick={() => {
                                    onPaneId("");
                                    onSurfaceId("");
                                    onPickKind("new_split");
                                }}
                            />
                        </>
                    ) : (
                        <p className="px-2 py-3 font-mono text-[10px] text-[var(--dd-text-muted)]">Pick a workspace</p>
                    )}
                </Column>

                <Column title="Terminal" delayMs={240}>
                    {selectedWorkspace && (selectedPane || newSplitActive) ? (
                        newSplitActive ? (
                            <p className="px-2 py-3 font-mono text-[10px] text-[var(--dd-text-muted)]">
                                Opens in a new pane split
                            </p>
                        ) : (
                            <>
                                {surfaces.map((surface) => (
                                    <PickButton
                                        key={surface.id}
                                        active={selectedSurface?.id === surface.id && existingSurfaceActive}
                                        disabled={surface.type !== "terminal"}
                                        onClick={() => {
                                            onSurfaceId(surface.id);
                                            onPickKind("existing_surface");
                                        }}
                                    >
                                        {surface.title}
                                        {surface.type !== "terminal" ? ` · ${surface.type}` : ""}
                                    </PickButton>
                                ))}
                                <PlusPickButton
                                    active={newSurfaceActive}
                                    label="New terminal"
                                    onClick={() => {
                                        onSurfaceId("");
                                        onPickKind("new_surface");
                                    }}
                                />
                            </>
                        )
                    ) : (
                        <p className="px-2 py-3 font-mono text-[10px] text-[var(--dd-text-muted)]">Pick a pane</p>
                    )}
                </Column>
            </div>

            {preview ? (
                <BezelCard className="shrink-0" innerClassName="dd-cmux-preview-pane overflow-auto bg-black/40 p-2">
                    <SemanticTerminalPreview preview={preview} />
                </BezelCard>
            ) : (
                <div className="h-[120px] shrink-0" aria-hidden />
            )}
        </div>
    );
}
