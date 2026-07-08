import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { BoardCanvas } from "@/components/boards/BoardCanvas";
import { boardsApi } from "@/components/boards/boards-api";
import type { Tool } from "@/components/boards/Toolbar";
import { useOperator } from "@/components/boards/useOperator";
import { useLockPageScroll } from "@/hooks/useLockPageScroll";

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
    const { operator, promptOpen, serverDefault, commit } = useOperator();

    const boardQuery = useQuery({
        queryKey: ["board", slug],
        queryFn: () => boardsApi.doc(slug),
    });

    const dispatchMutation = useMutation({
        mutationFn: () => boardsApi.dispatch(slug),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["board", slug] }),
    });

    useLockPageScroll(true);

    const stagedCount = boardQuery.data?.annotations.filter((a) => a.status === "staged").length ?? 0;

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
                {stagedCount > 0 ? (
                    <button
                        type="button"
                        onClick={() => dispatchMutation.mutate()}
                        disabled={dispatchMutation.isPending}
                        className="dd-btn-accent ml-auto rounded-full px-3 py-1 text-xs"
                    >
                        ↑ Send to Claude ({stagedCount})
                    </button>
                ) : null}
            </div>
            <div className="min-h-0 flex-1">
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
                        onSelectAnnotation={setSelectedAnnotationId}
                    />
                )}
            </div>
            {promptOpen ? <OperatorDialog defaultValue={serverDefault} onSubmit={commit} /> : null}
        </div>
    );
}
