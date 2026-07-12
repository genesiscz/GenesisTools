import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@ui/components/button";
import { type FormEvent, useState } from "react";
import { boardsApi } from "@/components/boards/boards-api";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function NewBoardForm() {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [slug, setSlug] = useState("");
    const [title, setTitle] = useState("");

    const createMutation = useMutation({
        mutationFn: () => boardsApi.create({ slug: slug.trim(), title: title.trim() || undefined }),
        onSuccess: (board) => {
            queryClient.invalidateQueries({ queryKey: ["boards"] });
            setSlug("");
            setTitle("");
            void navigate({ to: "/boards/$slug", params: { slug: board.slug } });
        },
    });

    const valid = SLUG_RE.test(slug.trim());

    const handleSubmit = (e: FormEvent) => {
        e.preventDefault();

        if (!valid || createMutation.isPending) {
            return;
        }

        createMutation.mutate();
    };

    return (
        <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2">
            <input
                type="text"
                aria-label="Board slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="board-slug..."
                className="min-w-[10rem] flex-1 rounded-md border border-[var(--dd-border)] bg-[var(--dd-bg-panel)] px-3 py-1.5 font-mono text-sm text-[var(--dd-text-primary)] outline-none focus:border-[var(--dd-accent-from)]"
            />
            <input
                type="text"
                aria-label="Board title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Title (optional)..."
                className="min-w-[10rem] flex-1 rounded-md border border-[var(--dd-border)] bg-[var(--dd-bg-panel)] px-3 py-1.5 text-sm text-[var(--dd-text-secondary)] outline-none focus:border-[var(--dd-accent-from)]"
            />
            <Button
                type="submit"
                variant="ghost"
                size="sm"
                disabled={!valid || createMutation.isPending}
                className="dd-btn-accent shrink-0 hover:bg-transparent"
            >
                {createMutation.isPending ? "Creating..." : "New board"}
            </Button>
            {createMutation.isError ? (
                <p className="w-full text-sm text-[var(--dd-danger)]">
                    {createMutation.error instanceof Error
                        ? createMutation.error.message
                        : String(createMutation.error)}
                </p>
            ) : null}
        </form>
    );
}

export function BoardsRoute() {
    const boardsQuery = useQuery({
        queryKey: ["boards"],
        queryFn: () => boardsApi.list(),
        refetchInterval: 10_000,
    });

    const boards = (boardsQuery.data?.boards ?? []).filter((board) => !board.archived);

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="dd-accent-text text-xl font-bold">Boards</h2>
            </div>

            <div className="dd-panel flex flex-col gap-4 p-4">
                <NewBoardForm />
            </div>

            {boardsQuery.isPending ? (
                <div className="py-8 text-center text-sm text-[var(--dd-text-muted)]">Loading boards...</div>
            ) : boards.length === 0 ? (
                <div className="dd-panel py-8 text-center text-sm text-[var(--dd-text-muted)]">No boards yet.</div>
            ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {boards.map((board) => (
                        <Link
                            key={board.slug}
                            to="/boards/$slug"
                            params={{ slug: board.slug }}
                            className="dd-panel flex flex-col gap-2 p-4 transition-colors hover:border-[var(--dd-accent-from)]"
                        >
                            <div className="flex items-center justify-between gap-2">
                                <span className="truncate font-mono text-sm text-[var(--dd-text-primary)]">
                                    {board.slug}
                                </span>
                                {board.openWork > 0 ? (
                                    <span className="shrink-0 rounded-full bg-[var(--dd-accent-from)] px-2 py-0.5 text-xs font-semibold text-[#0c0e10]">
                                        {board.openWork}
                                    </span>
                                ) : null}
                            </div>
                            <span className="truncate text-sm text-[var(--dd-text-secondary)]">
                                {board.title || "Untitled"}
                            </span>
                            <div className="mt-auto flex items-center justify-between gap-2 text-xs text-[var(--dd-text-muted)]">
                                {board.project ? (
                                    <span className="truncate rounded border border-[var(--dd-border)] px-1.5 py-0.5">
                                        {board.project}
                                    </span>
                                ) : (
                                    <span />
                                )}
                                <span className="shrink-0">{board.cardCount} cards</span>
                            </div>
                        </Link>
                    ))}
                </div>
            )}
        </div>
    );
}
