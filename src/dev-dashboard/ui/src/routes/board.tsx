import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { BoardCanvas } from "@/components/boards/BoardCanvas";
import { boardsApi } from "@/components/boards/boards-api";
import { useLockPageScroll } from "@/hooks/useLockPageScroll";

export function BoardRoute() {
    const { slug } = useParams({ from: "/boards/$slug" });
    const boardQuery = useQuery({
        queryKey: ["board", slug],
        queryFn: () => boardsApi.doc(slug),
    });

    useLockPageScroll(true);

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center gap-3 border-b border-[var(--dd-border)] bg-[var(--dd-bg-panel)] px-4 py-2">
                <Link
                    to="/boards"
                    className="text-sm text-[var(--dd-text-secondary)] hover:text-[var(--dd-accent-from)]"
                >
                    ← boards
                </Link>
                <span className="dd-accent-text font-mono text-sm font-bold">{slug}</span>
            </div>
            <div className="min-h-0 flex-1">
                {boardQuery.isPending ? (
                    <p className="p-4 text-sm text-[var(--dd-text-muted)]">Loading board...</p>
                ) : boardQuery.isError ? (
                    <p className="p-4 text-sm text-[var(--dd-danger)]">
                        {boardQuery.error instanceof Error ? boardQuery.error.message : String(boardQuery.error)}
                    </p>
                ) : (
                    <BoardCanvas doc={boardQuery.data} />
                )}
            </div>
        </div>
    );
}
