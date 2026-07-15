import { Button } from "@app/utils/ui/components/button";
import { Input } from "@app/utils/ui/components/input";
import { Loading } from "@app/utils/ui/components/youtube/loading";
import type { PipelineProgress, RunPipeline } from "@app/utils/ui/components/youtube/tabs";
import { formatRelativeTime } from "@app/utils/ui/components/youtube/time";
import type { VideoComment, VideoId } from "@app/youtube/lib/types";
import { Loader2, MessageCircle, Search, ThumbsUp } from "lucide-react";
import { useMemo, useState } from "react";

const DEFAULT_RENDER_LIMIT = 50;

interface CommentThread {
    root: VideoComment;
    replies: VideoComment[];
}

function buildThreads(comments: VideoComment[]): CommentThread[] {
    const known = new Set(comments.map((comment) => comment.commentId));
    const repliesByParent = new Map<string, VideoComment[]>();
    const roots: VideoComment[] = [];

    for (const comment of comments) {
        if (comment.parentCommentId && known.has(comment.parentCommentId)) {
            const siblings = repliesByParent.get(comment.parentCommentId) ?? [];
            siblings.push(comment);
            repliesByParent.set(comment.parentCommentId, siblings);
            continue;
        }

        roots.push(comment);
    }

    return roots.map((root) => ({ root, replies: repliesByParent.get(root.commentId) ?? [] }));
}

export interface CommentsTabProps {
    videoId: VideoId;
    useComments: (id: VideoId | null) => { data: { comments: VideoComment[] } | undefined; isPending: boolean };
    runPipeline?: RunPipeline;
    pipelineProgress?: PipelineProgress | null;
}

export function CommentsTab({ videoId, useComments, runPipeline, pipelineProgress }: CommentsTabProps) {
    const [query, setQuery] = useState("");
    const [showAll, setShowAll] = useState(false);
    const comments = useComments(videoId);
    const rows = comments.data?.comments ?? [];

    const threads = useMemo(() => buildThreads(rows), [rows]);

    const filtered = useMemo(() => {
        if (!query.trim()) {
            return threads;
        }

        const needle = query.toLowerCase();

        return threads.filter((thread) => {
            const haystack = [thread.root, ...thread.replies];
            return haystack.some(
                (comment) =>
                    comment.text.toLowerCase().includes(needle) || (comment.author ?? "").toLowerCase().includes(needle)
            );
        });
    }, [threads, query]);

    const trimmed = useMemo(() => {
        if (showAll || filtered.length <= DEFAULT_RENDER_LIMIT) {
            return filtered;
        }

        return filtered.slice(0, DEFAULT_RENDER_LIMIT);
    }, [filtered, showAll]);

    if (comments.isPending) {
        return <Loading label="Loading comments" />;
    }

    if (rows.length === 0) {
        const isRunning = (runPipeline?.isPending ?? false) || pipelineProgress != null;

        return (
            <div className="space-y-4 rounded-2xl border border-dashed border-primary/25 p-5">
                <div className="flex items-start gap-3">
                    <MessageCircle className="mt-0.5 size-5 shrink-0 text-primary" />
                    <div className="space-y-1">
                        <p className="font-mono text-xs uppercase tracking-[0.28em] text-secondary">No comments</p>
                        <p className="text-sm text-muted-foreground">
                            We haven't fetched comments for this video yet. Run the comments stage to pull the top
                            comment threads via yt-dlp.
                        </p>
                    </div>
                </div>
                {runPipeline ? (
                    <Button
                        data-testid="comments-run-pipeline"
                        onClick={() => runPipeline.run(["metadata", "comments"])}
                        disabled={isRunning}
                    >
                        {isRunning ? (
                            <>
                                <Loader2 className="size-4 animate-spin" /> Fetching comments…
                            </>
                        ) : (
                            "Fetch comments"
                        )}
                    </Button>
                ) : null}
                {pipelineProgress ? (
                    <p className="text-xs tabular-nums text-muted-foreground">
                        {Math.round(pipelineProgress.progress * 100)}%
                        {pipelineProgress.message ? ` · ${pipelineProgress.message}` : ""}
                    </p>
                ) : null}
            </div>
        );
    }

    const hidden = filtered.length - trimmed.length;

    return (
        <div className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <p className="font-mono text-xs uppercase tracking-[0.28em] text-secondary">Top Comments</p>
                    <h3 className="mt-2 text-2xl font-bold">Audience signal</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                        {rows.length.toLocaleString()} comment{rows.length === 1 ? "" : "s"} ·{" "}
                        {threads.length.toLocaleString()} thread{threads.length === 1 ? "" : "s"}
                    </p>
                </div>
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search comments"
                        className="pl-9 sm:w-64"
                    />
                </div>
            </div>
            <div className="yt-scroll max-h-[62vh] space-y-3 overflow-auto pr-2">
                {trimmed.map((thread) => (
                    <CommentThreadView key={thread.root.commentId} thread={thread} />
                ))}
            </div>
            {hidden > 0 ? (
                <div className="flex items-center justify-center gap-3 rounded-2xl border border-dashed border-primary/30 bg-primary/5 p-3 text-sm">
                    <span className="text-muted-foreground">
                        Showing first {DEFAULT_RENDER_LIMIT.toLocaleString()} of {filtered.length.toLocaleString()}{" "}
                        threads.
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
                        Show all {filtered.length.toLocaleString()}
                    </Button>
                </div>
            ) : null}
        </div>
    );
}

function CommentThreadView({ thread }: { thread: CommentThread }) {
    return (
        <article
            data-comment-id={thread.root.commentId}
            className="rounded-2xl border border-primary/15 bg-black/20 p-4"
        >
            <CommentRow comment={thread.root} />
            {thread.replies.length > 0 ? (
                <div className="mt-3 space-y-3 border-l border-primary/15 pl-4">
                    {thread.replies.map((reply) => (
                        <CommentRow key={reply.commentId} comment={reply} />
                    ))}
                </div>
            ) : null}
        </article>
    );
}

function CommentRow({ comment }: { comment: VideoComment }) {
    const author = comment.author ?? "Unknown";
    const relative = formatRelativeTime(comment.publishedAt);
    const initial = author.replace(/^@/, "").charAt(0).toUpperCase() || "?";

    return (
        <div className="flex gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-full bg-secondary/10 text-secondary">
                <span className="text-sm font-semibold">{initial}</span>
            </div>
            <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-sm font-semibold text-foreground/90">{author}</span>
                    {relative ? <span className="text-xs text-muted-foreground">{relative}</span> : null}
                </div>
                <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground/85">{comment.text}</p>
                {comment.likeCount !== null && comment.likeCount > 0 ? (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <ThumbsUp className="size-3.5" />
                        {comment.likeCount.toLocaleString()}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
