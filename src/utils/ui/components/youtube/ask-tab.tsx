import { Button } from "@app/utils/ui/components/button";
import { Input } from "@app/utils/ui/components/input";
import { Markdown } from "@app/utils/ui/components/markdown";
import { ShareButton } from "@app/utils/ui/components/youtube/share-button";
import { StyleSelect } from "@app/utils/ui/components/youtube/style-select";
import type { VideoDetailDataSource } from "@app/utils/ui/components/youtube/tabs";
import { formatTimecode } from "@app/utils/ui/components/youtube/time";
import type { AskCitation, QaHistoryItem, VideoId } from "@app/youtube/lib/types";
import { ChevronDown, ChevronRight, Loader2, LockKeyhole, MessageCircleQuestion } from "lucide-react";
import { useState } from "react";

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
        }) => Promise<{ answer: string; citations?: AskCitation[] }>;
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
}

/** One question+answer, rendered with citation links wired to the player. */
function ExchangeBody({
    answer,
    citations,
    onSeek,
}: {
    answer: string;
    citations: AskCitation[];
    onSeek: (seconds: number) => void;
}) {
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
            {citations.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-1.5">
                    {citations.map((citation, citationIndex) =>
                        citation.startSec !== null ? (
                            <button
                                key={citationIndex}
                                type="button"
                                onClick={() => onSeek(citation.startSec ?? 0)}
                                className="yt-timecode inline-flex h-6 items-center px-2 font-mono text-[12px] tabular-nums"
                            >
                                {formatTimecode(citation.startSec)}
                            </button>
                        ) : null
                    )}
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
}: {
    item: QaHistoryItem;
    expanded: boolean;
    onToggle: () => void;
    onSeek: (seconds: number) => void;
    createShare?: ReturnType<NonNullable<VideoDetailDataSource["useCreateShare"]>>;
    videoId: VideoId;
}) {
    const Chevron = expanded ? ChevronDown : ChevronRight;
    const [linkCopied, setLinkCopied] = useState(false);

    return (
        <article className="rounded-xl border border-white/8 bg-black/20">
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={expanded}
                className="flex w-full items-center gap-2 p-3 text-left transition-colors hover:bg-white/4"
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
                    <ExchangeBody answer={item.answer} citations={item.citations} onSeek={onSeek} />
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
}: AskTabProps) {
    const ask = useAskVideo(videoId);
    const createShare = useCreateShare?.();
    const userPresets = useListPresets?.("ask");
    const createPreset = useCreatePreset?.();
    const [presetId, setPresetId] = useState<number | null>(null);
    const [latestLinkCopied, setLatestLinkCopied] = useState(false);
    const history = useQaHistory?.(videoId);
    const [question, setQuestion] = useState("");
    const [error, setError] = useState<string | null>(null);
    // Session fallback for consumers without server history — keeps the live
    // answer visible when `useQaHistory` isn't wired.
    const [sessionExchange, setSessionExchange] = useState<{
        question: string;
        answer: string;
        citations: AskCitation[];
    } | null>(null);
    const [showOlder, setShowOlder] = useState(false);
    const [expandedIds, setExpandedIds] = useState<ReadonlySet<number>>(new Set());

    const items = history?.data?.items ?? [];
    const latest = items[0];
    const older = items.slice(1);
    const signInRequired = error === "login required";

    async function submit() {
        const trimmed = question.trim();

        if (trimmed === "" || ask.isPending) {
            return;
        }

        setError(null);
        try {
            const result = await ask.mutateAsync({ question: trimmed, presetId: presetId ?? undefined });

            if (!useQaHistory) {
                setSessionExchange({ question: trimmed, answer: result.answer, citations: result.citations ?? [] });
            }

            setQuestion("");
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
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
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-secondary">Ask the video</p>
                <p className="mt-1 text-sm text-muted-foreground">
                    Answers come from the transcript (semantic search + your configured LLM), with timestamp citations.
                </p>
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
                <div className="flex items-start gap-3 rounded-2xl border border-white/8 bg-black/20 p-4">
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

            {!latest && !sessionExchange && !ask.isPending && !error ? (
                <div className="flex items-start gap-3 rounded-2xl border border-dashed border-primary/25 p-5">
                    <MessageCircleQuestion className="mt-0.5 size-5 shrink-0 text-primary" />
                    <p className="text-sm text-muted-foreground">
                        No questions yet. The first question indexes the transcript, so it takes a little longer.
                    </p>
                </div>
            ) : null}

            {sessionExchange && !useQaHistory ? (
                <article className="rounded-2xl border border-white/8 bg-black/20 p-3">
                    <p className="text-sm font-semibold text-foreground/95">{sessionExchange.question}</p>
                    <ExchangeBody
                        answer={sessionExchange.answer}
                        citations={sessionExchange.citations}
                        onSeek={onSeek}
                    />
                </article>
            ) : null}

            {latest ? (
                <article className="rounded-2xl border border-white/8 bg-black/20 p-3">
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
                    <ExchangeBody answer={latest.answer} citations={latest.citations} onSeek={onSeek} />
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
                                />
                            ))}
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
