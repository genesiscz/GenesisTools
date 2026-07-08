import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { BoardCanvas } from "@/components/boards/BoardCanvas";
import { boardsApi } from "@/components/boards/boards-api";
import type { Tool } from "@/components/boards/Toolbar";
import { useBoardEvents } from "@/components/boards/useBoardEvents";
import { useOperator } from "@/components/boards/useOperator";
import { WirePanel } from "@/components/boards/WirePanel";
import { LiveSseIndicator } from "@/components/LiveSseIndicator";
import { useLockPageScroll } from "@/hooks/useLockPageScroll";

interface SetVersionPayload {
    project: string;
    branch: string;
    version: number;
    key: string;
}

function isSetVersionPayload(payload: unknown): payload is SetVersionPayload {
    if (typeof payload !== "object" || payload === null) {
        return false;
    }

    const p = payload as Record<string, unknown>;
    return (
        typeof p.project === "string" &&
        typeof p.branch === "string" &&
        typeof p.version === "number" &&
        typeof p.key === "string"
    );
}

function OperatorDialog({ defaultValue, onSubmit }: { defaultValue: string; onSubmit: (name: string) => void }) {
    const [name, setName] = useState(defaultValue);

    return (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60">
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    onSubmit(name);
                }}
                className="dd-panel w-72 p-4"
            >
                <p className="mb-2 text-sm font-semibold text-[var(--dd-text-primary)]">YOU ARE</p>
                <input
                    autoFocus
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="your name..."
                    className="mb-3 w-full rounded border border-[var(--dd-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--dd-text-primary)] outline-none focus:border-[var(--dd-accent-from)]"
                />
                <button type="submit" className="dd-btn-accent w-full rounded-md px-3 py-1.5 text-sm">
                    Continue
                </button>
            </form>
        </div>
    );
}

export function BoardRoute() {
    const { slug } = useParams({ from: "/boards/$slug" });
    const queryClient = useQueryClient();
    const [tool, setTool] = useState<Tool>("move");
    const [selectedAnnotationId, setSelectedAnnotationId] = useState<number | null>(null);
    const [panelOpen, setPanelOpen] = useState(false);
    const [syncBanner, setSyncBanner] = useState<SetVersionPayload | null>(null);
    const { operator, promptOpen, serverDefault, commit } = useOperator();

    const boardQuery = useQuery({
        queryKey: ["board", slug],
        queryFn: () => boardsApi.doc(slug),
        staleTime: 500,
        refetchInterval: 15_000,
    });
    const { live } = useBoardEvents(slug, (e) => {
        if (e.type === "set_version" && isSetVersionPayload(e.payload)) {
            setSyncBanner(e.payload);
        }
    });

    const dispatchMutation = useMutation({
        mutationFn: () => boardsApi.dispatch(slug),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["board", slug] }),
    });

    const syncMutation = useMutation({
        mutationFn: () => {
            const banner = syncBanner as SetVersionPayload;
            return boardsApi.syncSet(slug, {
                project: banner.project,
                branch: banner.branch,
                selector: String(banner.version),
            });
        },
        onSuccess: () => {
            setSyncBanner(null);
            queryClient.invalidateQueries({ queryKey: ["board", slug] });
        },
    });

    useLockPageScroll(true);

    const stagedCount = boardQuery.data?.annotations.filter((a) => a.status === "staged").length ?? 0;
    const selectedAnnotation = boardQuery.data?.annotations.find((a) => a.id === selectedAnnotationId) ?? null;

    return (
        <div className="relative flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center gap-3 border-b border-[var(--dd-border)] bg-[var(--dd-bg-panel)] px-4 py-2">
                <Link
                    to="/boards"
                    className="text-sm text-[var(--dd-text-secondary)] hover:text-[var(--dd-accent-from)]"
                >
                    ← boards
                </Link>
                <span className="dd-accent-text font-mono text-sm font-bold">{slug}</span>
                <div className="ml-auto flex items-center gap-3">
                    <LiveSseIndicator live={live} count={boardQuery.data?.cards.length ?? 0} />
                    <button
                        type="button"
                        onClick={() => setPanelOpen((v) => !v)}
                        className="text-sm text-[var(--dd-text-secondary)] hover:text-[var(--dd-text-primary)]"
                    >
                        thread
                    </button>
                    {stagedCount > 0 ? (
                        <button
                            type="button"
                            onClick={() => dispatchMutation.mutate()}
                            disabled={dispatchMutation.isPending}
                            className="dd-btn-accent rounded-full px-3 py-1 text-xs"
                        >
                            ↑ Send to Claude ({stagedCount})
                        </button>
                    ) : null}
                </div>
            </div>
            {syncBanner ? (
                <div className="flex shrink-0 items-center gap-3 border-b border-[var(--dd-border)] bg-[var(--dd-bg-panel)] px-4 py-1.5 text-xs text-[var(--dd-text-secondary)]">
                    <span>
                        set {syncBanner.key} has v{syncBanner.version} — sync board
                    </span>
                    <button
                        type="button"
                        onClick={() => syncMutation.mutate()}
                        disabled={syncMutation.isPending}
                        className="dd-btn-accent rounded-full px-2 py-0.5"
                    >
                        sync
                    </button>
                </div>
            ) : null}
            <div className="flex min-h-0 flex-1">
                <div className="min-h-0 min-w-0 flex-1">
                    {boardQuery.isPending ? (
                        <p className="p-4 text-sm text-[var(--dd-text-muted)]">Loading board...</p>
                    ) : boardQuery.isError ? (
                        <p className="p-4 text-sm text-[var(--dd-danger)]">
                            {boardQuery.error instanceof Error ? boardQuery.error.message : String(boardQuery.error)}
                        </p>
                    ) : (
                        <BoardCanvas
                            slug={slug}
                            doc={boardQuery.data}
                            tool={tool}
                            onToolChange={setTool}
                            operator={operator}
                            selectedAnnotationId={selectedAnnotationId}
                            onSelectAnnotation={(id) => {
                                setSelectedAnnotationId(id);
                                setPanelOpen(true);
                            }}
                        />
                    )}
                </div>
                {panelOpen ? (
                    <WirePanel
                        slug={slug}
                        annotation={selectedAnnotation}
                        boardMessages={boardQuery.data?.boardMessages ?? []}
                        operator={operator}
                        onClose={() => setPanelOpen(false)}
                    />
                ) : null}
            </div>
            {promptOpen ? <OperatorDialog defaultValue={serverDefault} onSubmit={commit} /> : null}
        </div>
    );
}
