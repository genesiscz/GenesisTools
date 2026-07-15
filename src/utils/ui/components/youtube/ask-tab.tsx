import { logger } from "@app/logger/client";
import { Button } from "@app/utils/ui/components/button";
import { Input } from "@app/utils/ui/components/input";
import { Markdown } from "@app/utils/ui/components/markdown";
import { ShareButton } from "@app/utils/ui/components/youtube/share-button";
import { StyleSelect } from "@app/utils/ui/components/youtube/style-select";
import type { PipelineProgress, RunPipeline, VideoDetailDataSource } from "@app/utils/ui/components/youtube/tabs";
import { formatTimecode } from "@app/utils/ui/components/youtube/time";
import type { AskCitation, QaHistoryItem, QaSource, VideoComment, VideoId } from "@app/youtube/lib/types";
import { CREDIT_COSTS } from "@app/youtube/lib/types";
import { ChevronDown, ChevronRight, Loader2, LockKeyhole, MessageCircleQuestion, MessagesSquare } from "lucide-react";
import { useState } from "react";

type AskScope = "video" | "comments" | "both" | "channel";

const SCOPE_SOURCES: Record<AskScope, QaSource[]> = {
    video: ["transcript"],
    comments: ["comments"],
    both: ["transcript", "comments"],
    channel: ["transcript"],
};

const SCOPE_LABELS: Array<{ scope: AskScope; label: string }> = [
    { scope: "video", label: "Video" },
    { scope: "comments", label: "Comments" },
    { scope: "both", label: "Both" },
    { scope: "channel", label: "Channel" },
];

/** Metadata for cited videos, from the ask response — drives grouped headers. */
export type CitedVideoMap = Record<string, { title: string; uploadDate: string | null; thumbUrl: string | null }>;

/** Replace the model's inline `[#4]` citation markers with `#cite-N` anchor
 *  links labelled by the cited timestamp — the answer container intercepts
 *  clicks and seeks the player. */
function linkifyCitations(answer: string, citations: AskCitation[]): string {
    return answer.replace(/\[#(\d+)\]/g, (match, index: string) => {
        const citation = citations[Number(index) - 1];

        if (!citation || citation.startSec === null) {
            return match;
        }

        return `[${formatTimecode(citation.startSec)}](#cite-${index})`;
    });
}

export interface AskTabProps {
    videoId: VideoId;
    onSeek: (seconds: number) => void;
    useAskVideo: (id: VideoId) => {
        mutateAsync: (vars: {
            question: string;
            topK?: number;
            provider?: string;
            model?: string;
            presetId?: number;
            sources?: QaSource[];
            scope?: "video" | "channel";
        }) => Promise<{ answer: string; citations?: AskCitation[]; citedVideos?: CitedVideoMap }>;
        isPending: boolean;
    };
    /** Server-side per-user history — persists across reloads. Optional for
     *  consumers without user accounts (they only see the live exchange). */
    useQaHistory?: (id: VideoId | null) => {
        data: { items: QaHistoryItem[] } | undefined;
        isPending: boolean;
    };
    useCreateShare?: VideoDetailDataSource["useCreateShare"];
    useListPresets?: VideoDetailDataSource["useListPresets"];
    useCreatePreset?: VideoDetailDataSource["useCreatePreset"];
    /** Invoked by the "Sign in" affordance when the ask endpoint returns 401. */
    onRequireLogin?: () => void;
    /** Comments presence check for the Comments/Both scopes. */
    useComments?: (id: VideoId | null) => {
        data: { comments: VideoComment[] } | undefined;
        isPending: boolean;
    };
    /** Existing pipeline trigger — powers the "Fetch comments" affordance. */
    runPipeline?: RunPipeline;
    pipelineProgress?: PipelineProgress | null;
    /** Jump to a cited comment thread (switch tab + scroll + flash). */
    onShowComment?: (commentId: string) => void;
    /** Open another video's watch page at a timestamp (cross-video citations). */
    onOpenWatch?: (videoId: string, t: number) => void;
    /** Signed-in user's output-language preference (2-letter ISO). Default "en" — drives the "· CS" header suffix. */
    outputLang?: string;
}

/** One question+answer, rendered with citation links wired to the player. */
function ExchangeBody({
    answer,
    citations,
    onSeek,
    onShowComment,
    currentVideoId,
    citedVideos,
    onOpenWatch,
}: {
    answer: string;
    citations: AskCitation[];
    onSeek: (seconds: number) => void;
    onShowComment?: (commentId: string) => void;
    currentVideoId?: string;
    citedVideos?: CitedVideoMap;
    onOpenWatch?: (videoId: string, t: number) => void;
}) {
    const commentCitations = citations.filter(
        (citation) => citation.source === "comments" && citation.commentId !== null
    );
    const distinctVideos = [...new Set(citations.map((citation) => citation.videoId))];
    const crossVideo =
        distinctVideos.length > 1 ||
        (currentVideoId !== undefined && distinctVideos.some((videoId) => videoId !== currentVideoId));

    function pillFor(citation: AskCitation, key: number) {
        if (citation.source === "comments" && citation.commentId !== null) {
            return (
                <button
                    key={`comment-${key}`}
                    type="button"
                    onClick={() => citation.commentId && onShowComment?.(citation.commentId)}
                    className="inline-flex h-6 items-center rounded-full border border-border bg-muted/30 px-2 text-[12px] font-mono"
                >
                    @{(citation.author ?? "unknown").replace(/^@/, "")}
                </button>
            );
        }

        if (citation.startSec === null) {
            return null;
        }

        const isCurrent = currentVideoId === undefined || citation.videoId === currentVideoId;

        return (
            <button
                key={key}
                type="button"
                onClick={() =>
                    isCurrent ? onSeek(citation.startSec ?? 0) : onOpenWatch?.(citation.videoId, citation.startSec ?? 0)
                }
                className="yt-timecode inline-flex h-6 items-center px-2 font-mono text-[12px] tabular-nums"
            >
                {formatTimecode(citation.startSec)}
            </button>
        );
    }

    return (
        <>
            <Markdown
                md={linkifyCitations(answer, citations)}
                className="yt-md mt-2"
                onClick={(event) => {
                    const anchor = (event.target as HTMLElement).closest?.('a[href^="#cite-"]');

                    if (!anchor) {
                        return;
                    }

                    event.preventDefault();
                    const index = Number(anchor.getAttribute("href")?.slice("#cite-".length));
                    const citation = citations[index - 1];

                    if (citation?.startSec != null) {
                        onSeek(citation.startSec);
                    }
                }}
            />
            {citations.length > 0 && crossVideo ? (
                <div className="space-y-2">
                    {distinctVideos.map((videoId) => {
                        const meta = citedVideos?.[videoId];

                        return (
                            <div key={videoId}>
                                <div className="mt-3 flex items-center gap-2">
                                    {meta?.thumbUrl ? (
                                        <img src={meta.thumbUrl} alt="" className="h-6 w-10 rounded-md object-cover" />
                                    ) : null}
                                    <span className="truncate text-sm font-medium">{meta?.title ?? videoId}</span>
                                    {meta?.uploadDate ? (
                                        <span className="text-[12px] font-mono text-muted-foreground">
                                            {meta.uploadDate}
                                        </span>
                                    ) : null}
                                </div>
                                <div className="mt-1.5 flex flex-wrap gap-1.5">
                                    {citations.map((citation, citationIndex) =>
                                        citation.videoId === videoId ? pillFor(citation, citationIndex) : null
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : citations.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-1.5">
                    {citations.map((citation, citationIndex) =>
                        citation.source !== "comments" && citation.startSec !== null
                            ? pillFor(citation, citationIndex)
                            : null
                    )}
                    {commentCitations.map((citation, citationIndex) => pillFor(citation, citationIndex))}
                </div>
            ) : null}
        </>
    );
}

/** Older history entry: a question row that expands to the full answer. */
function HistoryRow({
    item,
    expanded,
    onToggle,
    onSeek,
    createShare,
    videoId,
    onShowComment,
    currentVideoId,
    onOpenWatch,
}: {
    item: QaHistoryItem;
    expanded: boolean;
    onToggle: () => void;
    onSeek: (seconds: number) => void;
    createShare?: ReturnType<NonNullable<VideoDetailDataSource["useCreateShare"]>>;
    videoId: VideoId;
    onShowComment?: (commentId: string) => void;
    currentVideoId?: string;
    onOpenWatch?: (videoId: string, t: number) => void;
}) {
    const Chevron = expanded ? ChevronDown : ChevronRight;
    const [linkCopied, setLinkCopied] = useState(false);

    return (
        <article className="rounded-xl border border-border bg-muted/30">
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={expanded}
                className="flex w-full items-center gap-2 p-3 text-left transition-colors hover:bg-muted"
            >
                <Chevron className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={2} />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground/90">{item.question}</span>
            </button>
            {expanded ? (
                <div className="px-3 pb-3">
                    {createShare ? (
                        <div className="mb-2 flex items-center justify-end gap-2">
                            {linkCopied ? <p className="text-sm text-primary">Link copied</p> : null}
                            <ShareButton
                                onShare={() => createShare.mutateAsync({ kind: "qa", videoId, qaHistoryId: item.id })}
                                onCopied={() => {
                                    setLinkCopied(true);
                                    setTimeout(() => setLinkCopied(false), 2000);
                                }}
                            />
                        </div>
                    ) : null}
                    <ExchangeBody
                        answer={item.answer}
                        citations={item.citations}
                        onSeek={onSeek}
                        onShowComment={onShowComment}
                        currentVideoId={currentVideoId}
                        onOpenWatch={onOpenWatch}
                    />
                </div>
            ) : null}
        </article>
    );
}

export function AskTab({
    videoId,
    onSeek,
    useAskVideo,
    useQaHistory,
    useCreateShare,
    useListPresets,
    useCreatePreset,
    onRequireLogin,
    useComments,
    runPipeline,
    pipelineProgress,
    onShowComment,
    onOpenWatch,
    outputLang,
}: AskTabProps) {
    const ask = useAskVideo(videoId);
    const createShare = useCreateShare?.();
    const userPresets = useListPresets?.("ask");
    const createPreset = useCreatePreset?.();
    const [presetId, setPresetId] = useState<number | null>(null);
    const [latestLinkCopied, setLatestLinkCopied] = useState(false);
    const history = useQaHistory?.(videoId);
    const comments = useComments?.(videoId);
    const [scope, setScope] = useState<AskScope>("video");
    const [question, setQuestion] = useState("");
    const [error, setError] = useState<string | null>(null);
    // Session fallback for consumers without server history — keeps the live
    // answer visible when `useQaHistory` isn't wired.
    const [sessionExchange, setSessionExchange] = useState<{
        question: string;
        answer: string;
        citations: AskCitation[];
        citedVideos?: CitedVideoMap;
    } | null>(null);
    const [lastCitedVideos, setLastCitedVideos] = useState<CitedVideoMap | undefined>(undefined);
    const [showOlder, setShowOlder] = useState(false);
    const [expandedIds, setExpandedIds] = useState<ReadonlySet<number>>(new Set());

    const items = history?.data?.items ?? [];
    const latest = items[0];
    const older = items.slice(1);
    const signInRequired = error === "login required";
    const commentsUnfetched = useComments !== undefined && (comments?.data?.comments.length ?? 0) === 0;
    const needsCommentsFetch = (scope === "comments" || scope === "both") && commentsUnfetched;

    async function submit() {
        const trimmed = question.trim();

        if (trimmed === "" || ask.isPending) {
            return;
        }

        setError(null);
        try {
            const result = await ask.mutateAsync({
                question: trimmed,
                presetId: presetId ?? undefined,
                sources: SCOPE_SOURCES[scope],
                scope: scope === "channel" ? "channel" : "video",
            });
            setLastCitedVideos(result.citedVideos);

            if (!useQaHistory) {
                setSessionExchange({
                    question: trimmed,
                    answer: result.answer,
                    citations: result.citations ?? [],
                    citedVideos: result.citedVideos,
                });
            }

            setQuestion("");
        } catch (error) {
            logger.warn({ error }, "ask-tab: submit failed");
            setError(error instanceof Error ? error.message : String(error));
        }
    }

    function toggleRow(id: number) {
        setExpandedIds((prev) => {
            const next = new Set(prev);

            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }

            return next;
        });
    }

    return (
        <div className="space-y-4">
            <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-secondary">
                    Ask the video
                    {outputLang && outputLang !== "en" ? ` · ${outputLang.toUpperCase()}` : ""}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                    {scope === "channel" ? (
                        <>
                            Searches across this channel's indexed videos ·{" "}
                            <span className="tabular-nums text-foreground/80">{CREDIT_COSTS["qa:channel"]} 💎</span> per
                            ask
                        </>
                    ) : (
                        "Answers come from the transcript (semantic search + your configured LLM), with timestamp citations."
                    )}
                </p>
            </div>

            <div
                role="group"
                aria-label="Ask scope"
                className="inline-flex rounded-full border border-border bg-muted/30 p-0.5"
            >
                {SCOPE_LABELS.map(({ scope: value, label }) => (
                    <button
                        key={value}
                        type="button"
                        data-testid={`ask-scope-${value}`}
                        aria-pressed={scope === value}
                        onClick={() => setScope(value)}
                        className={`h-7 rounded-full px-3 text-sm transition-colors ${
                            scope === value
                                ? "bg-primary/15 font-medium text-primary"
                                : "text-muted-foreground hover:text-foreground"
                        }`}
                    >
                        {label}
                    </button>
                ))}
            </div>

            <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                    event.preventDefault();
                    void submit();
                }}
            >
                <Input
                    value={question}
                    onChange={(event) => setQuestion(event.target.value)}
                    placeholder="What does the video say about…?"
                    disabled={ask.isPending}
                    className="h-9 flex-1 text-sm"
                />
                <Button type="submit" size="sm" disabled={ask.isPending || question.trim() === ""}>
                    {ask.isPending ? (
                        <>
                            <Loader2 className="size-4 animate-spin" /> Thinking…
                        </>
                    ) : (
                        "Ask"
                    )}
                </Button>
            </form>

            {userPresets && createPreset ? (
                <StyleSelect
                    kind="ask"
                    presets={userPresets.data ?? []}
                    selectedId={presetId}
                    onSelect={setPresetId}
                    onCreate={createPreset.mutateAsync}
                    creating={createPreset.isPending}
                />
            ) : null}

            {signInRequired ? (
                <div className="flex items-start gap-3 rounded-2xl border border-border bg-muted/30 p-4">
                    <LockKeyhole className="mt-0.5 size-4 shrink-0 text-secondary" strokeWidth={2} />
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground/95">Sign in required</p>
                        <p className="mt-0.5 text-sm text-muted-foreground">
                            Questions cost diamonds, so they need an account.
                        </p>
                        {onRequireLogin ? (
                            <Button size="sm" className="mt-2.5" onClick={onRequireLogin}>
                                Sign in
                            </Button>
                        ) : null}
                    </div>
                </div>
            ) : error ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-sm">
                    <p className="break-words text-destructive/90">{error}</p>
                </div>
            ) : null}

            {needsCommentsFetch ? (
                <div className="flex items-start gap-3 rounded-2xl border border-dashed border-primary/25 p-5">
                    <MessagesSquare className="mt-0.5 size-5 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1 space-y-2.5">
                        <p className="text-sm text-muted-foreground">Comments aren't fetched yet.</p>
                        {runPipeline ? (
                            <Button
                                size="sm"
                                variant="outline"
                                data-testid="ask-fetch-comments"
                                onClick={() => runPipeline.run(["metadata", "comments"])}
                                disabled={runPipeline.isPending || pipelineProgress != null}
                            >
                                {runPipeline.isPending || pipelineProgress != null ? (
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
                </div>
            ) : !latest && !sessionExchange && !ask.isPending && !error ? (
                <div className="flex items-start gap-3 rounded-2xl border border-dashed border-primary/25 p-5">
                    <MessageCircleQuestion className="mt-0.5 size-5 shrink-0 text-primary" />
                    <p className="text-sm text-muted-foreground">
                        No questions yet. The first question indexes the transcript, so it takes a little longer.
                    </p>
                </div>
            ) : null}

            {sessionExchange && !useQaHistory ? (
                <article className="rounded-2xl border border-border bg-muted/30 p-3">
                    <p className="text-sm font-semibold text-foreground/95">{sessionExchange.question}</p>
                    <ExchangeBody
                        answer={sessionExchange.answer}
                        citations={sessionExchange.citations}
                        onSeek={onSeek}
                        onShowComment={onShowComment}
                        currentVideoId={videoId}
                        citedVideos={sessionExchange.citedVideos}
                        onOpenWatch={onOpenWatch}
                    />
                </article>
            ) : null}

            {latest ? (
                <article className="rounded-2xl border border-border bg-muted/30 p-3">
                    <div className="flex items-start justify-between gap-3">
                        <p className="min-w-0 flex-1 text-sm font-semibold text-foreground/95">{latest.question}</p>
                        {createShare ? (
                            <ShareButton
                                className="shrink-0"
                                onShare={() => createShare.mutateAsync({ kind: "qa", videoId, qaHistoryId: latest.id })}
                                onCopied={() => {
                                    setLatestLinkCopied(true);
                                    setTimeout(() => setLatestLinkCopied(false), 2000);
                                }}
                            />
                        ) : null}
                    </div>
                    {latestLinkCopied ? <p className="text-sm text-primary">Link copied</p> : null}
                    <ExchangeBody
                        answer={latest.answer}
                        citations={latest.citations}
                        onSeek={onSeek}
                        onShowComment={onShowComment}
                        currentVideoId={videoId}
                        citedVideos={lastCitedVideos}
                        onOpenWatch={onOpenWatch}
                    />
                </article>
            ) : null}

            {older.length > 0 ? (
                <div className="space-y-2">
                    <button
                        type="button"
                        onClick={() => setShowOlder((value) => !value)}
                        aria-expanded={showOlder}
                        className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:text-foreground"
                    >
                        {showOlder ? (
                            <ChevronDown className="size-3" strokeWidth={2} />
                        ) : (
                            <ChevronRight className="size-3" strokeWidth={2} />
                        )}
                        History ({older.length})
                    </button>
                    {showOlder ? (
                        <div className="space-y-2">
                            {older.map((item) => (
                                <HistoryRow
                                    key={item.id}
                                    item={item}
                                    expanded={expandedIds.has(item.id)}
                                    onToggle={() => toggleRow(item.id)}
                                    onSeek={onSeek}
                                    createShare={createShare}
                                    videoId={videoId}
                                    onShowComment={onShowComment}
                                    currentVideoId={videoId}
                                    onOpenWatch={onOpenWatch}
                                />
                            ))}
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
