import { Button } from "@app/utils/ui/components/button";
import { Input } from "@app/utils/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@app/utils/ui/components/select";
import { Loading } from "@app/utils/ui/components/youtube/loading";
import type { PipelineProgress, RunPipeline } from "@app/utils/ui/components/youtube/tabs";
import { formatTimecode } from "@app/utils/ui/components/youtube/time";
import { segmentsToParagraphs, type TranscriptParagraph } from "@app/utils/ui/components/youtube/transcript-paragraphs";
import type { Transcript, TranscriptSegment, VideoId } from "@app/youtube/lib/types";
import { Captions, ChevronDown, ChevronUp, Loader2, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

const DEFAULT_RENDER_LIMIT = 200;
const DEFAULT_BUCKET_SEC = 120;
const BUCKET_OPTIONS: { value: string; label: string }[] = [
    { value: "0", label: "No grouping" },
    { value: "30", label: "30 sec" },
    { value: "60", label: "1 min" },
    { value: "120", label: "2 min" },
    { value: "300", label: "5 min" },
    { value: "600", label: "10 min" },
];

interface TranscriptBlock {
    start: number;
    end: number;
    paragraphs: TranscriptParagraph[];
}

function bucketSegments(segments: TranscriptSegment[], bucketSec: number): TranscriptBlock[] {
    if (segments.length === 0) {
        return [];
    }

    // No grouping = one bucket per segment; paragraph splitter turns it into
    // one paragraph per row.
    if (bucketSec <= 0) {
        return segments.map((segment) => ({
            start: segment.start,
            end: segment.end,
            paragraphs: segmentsToParagraphs([segment]),
        }));
    }

    const bucketed: { start: number; end: number; segments: TranscriptSegment[] }[] = [];
    let current: { start: number; end: number; segments: TranscriptSegment[] } | null = null;
    let bucketBoundary = 0;

    for (const segment of segments) {
        if (!current || segment.start >= bucketBoundary) {
            if (current) {
                bucketed.push(current);
            }
            const blockStart = Math.floor(segment.start / bucketSec) * bucketSec;
            bucketBoundary = blockStart + bucketSec;
            current = { start: blockStart, end: segment.end, segments: [segment] };
            continue;
        }

        current.end = segment.end;
        current.segments.push(segment);
    }

    if (current) {
        bucketed.push(current);
    }

    return bucketed.map((b) => ({
        start: b.start,
        end: b.end,
        paragraphs: segmentsToParagraphs(b.segments),
    }));
}

export interface TranscriptTabProps {
    videoId: VideoId;
    onSeek: (seconds: number) => void;
    useTranscript: (
        id: VideoId | null,
        opts?: { lang?: string; source?: "captions" | "ai" }
    ) => { data: { transcript: Transcript } | undefined; isPending: boolean };
    runPipeline?: RunPipeline;
    pipelineProgress?: PipelineProgress | null;
}

export function TranscriptTab({ videoId, onSeek, useTranscript, runPipeline, pipelineProgress }: TranscriptTabProps) {
    const [query, setQuery] = useState("");
    const [showAll, setShowAll] = useState(false);
    const [bucketSec, setBucketSec] = useState<number>(DEFAULT_BUCKET_SEC);
    const [currentMatch, setCurrentMatch] = useState(0);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const transcript = useTranscript(videoId);
    const segments = transcript.data?.transcript.segments ?? [];
    const needle = query.trim().toLowerCase();

    const blocks = useMemo(() => bucketSegments(segments, bucketSec), [segments, bucketSec]);

    const filtered = useMemo(() => {
        if (!needle) {
            return blocks;
        }

        return blocks.filter((block) => block.paragraphs.some((p) => p.text.toLowerCase().includes(needle)));
    }, [blocks, needle]);

    const trimmed = useMemo(() => {
        if (showAll || needle || filtered.length <= DEFAULT_RENDER_LIMIT) {
            return filtered;
        }

        return filtered.slice(0, DEFAULT_RENDER_LIMIT);
    }, [filtered, showAll, needle]);

    // Global match numbering: each rendered paragraph knows the index of its
    // first match, so marks can carry stable `data-match` ids for navigation.
    const matches = useMemo(() => {
        if (!needle) {
            return { total: 0, starts: [] as number[][] };
        }

        let running = 0;
        const starts = trimmed.map((block) =>
            block.paragraphs.map((paragraph) => {
                const start = running;
                running += countOccurrences(paragraph.text.toLowerCase(), needle);
                return start;
            })
        );

        return { total: running, starts };
    }, [trimmed, needle]);

    useEffect(() => {
        setCurrentMatch(0);
    }, [needle]);

    useEffect(() => {
        if (matches.total > 0 && currentMatch >= matches.total) {
            setCurrentMatch(0);
        }
    }, [matches.total, currentMatch]);

    useEffect(() => {
        if (matches.total === 0) {
            return;
        }

        scrollRef.current
            ?.querySelector(`[data-match="${currentMatch}"]`)
            ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, [currentMatch, matches.total]);

    function stepMatch(delta: 1 | -1): void {
        if (matches.total === 0) {
            return;
        }

        setCurrentMatch((prev) => (prev + delta + matches.total) % matches.total);
    }

    if (transcript.isPending) {
        return <Loading label="Loading transcript" />;
    }

    if (segments.length === 0) {
        const isRunning = (runPipeline?.isPending ?? false) || pipelineProgress != null;

        return (
            <div className="space-y-4 rounded-2xl border border-dashed border-primary/25 p-5">
                <div className="flex items-start gap-3">
                    <Captions className="mt-0.5 size-5 shrink-0 text-primary" />
                    <div className="space-y-1">
                        <p className="font-mono text-xs uppercase tracking-[0.28em] text-secondary">No transcript</p>
                        <p className="text-sm text-muted-foreground">
                            We haven't fetched captions for this video yet. Run the captions stage to grab YouTube's
                            captions, falling back to audio + AI transcription if needed.
                        </p>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    {runPipeline ? (
                        <Button
                            data-testid="transcript-run-pipeline"
                            onClick={() => runPipeline.run(["captions"])}
                            disabled={isRunning}
                        >
                            {isRunning ? (
                                <>
                                    <Loader2 className="size-4 animate-spin" /> Fetching transcript…
                                </>
                            ) : (
                                "Fetch transcript"
                            )}
                        </Button>
                    ) : null}
                    {pipelineProgress ? (
                        <span className="text-xs tabular-nums text-muted-foreground">
                            {Math.round(pipelineProgress.progress * 100)}%
                            {pipelineProgress.message ? ` · ${pipelineProgress.message}` : ""}
                        </span>
                    ) : null}
                    <span className="font-mono text-xs text-muted-foreground/70">
                        Or run{" "}
                        <code className="rounded bg-black/30 px-1.5 py-0.5">tools youtube transcribe {videoId}</code>
                    </span>
                </div>
            </div>
        );
    }

    const hidden = filtered.length - trimmed.length;
    const totalParagraphs = filtered.reduce((n, b) => n + b.paragraphs.length, 0);

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <Select value={String(bucketSec)} onValueChange={(value) => setBucketSec(Number(value))}>
                    <SelectTrigger className="h-8 w-[110px]">
                        <SelectValue placeholder="Group by" />
                    </SelectTrigger>
                    <SelectContent>
                        {BUCKET_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                                {option.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <div className="relative flex-1 min-w-[140px]">
                    <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key !== "Enter") {
                                return;
                            }

                            event.preventDefault();
                            stepMatch(event.shiftKey ? -1 : 1);
                        }}
                        placeholder="Search"
                        className={
                            needle && matches.total === 0
                                ? "h-8 flex-1 pl-8 text-sm ring-1 ring-muted-foreground/25"
                                : "h-8 flex-1 pl-8 text-sm"
                        }
                    />
                </div>
                {needle ? (
                    <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
                        {matches.total === 0 ? "0/0" : `${currentMatch + 1}/${matches.total}`}
                    </span>
                ) : null}
                <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Previous match"
                    onClick={() => stepMatch(-1)}
                    disabled={matches.total === 0}
                >
                    <ChevronUp className="size-4" />
                </Button>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Next match"
                    onClick={() => stepMatch(1)}
                    disabled={matches.total === 0}
                >
                    <ChevronDown className="size-4" />
                </Button>
                <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
                    {segments.length.toLocaleString()} segments · {totalParagraphs.toLocaleString()} paragraphs
                </span>
            </div>
            <div ref={scrollRef} className="yt-scroll min-w-0 space-y-4 overflow-y-auto">
                {trimmed.map((block, index) => (
                    <TranscriptRow
                        key={`${block.start}-${index}`}
                        block={block}
                        showRange={bucketSec > 0}
                        query={needle}
                        matchStarts={matches.starts[index] ?? []}
                        currentMatch={currentMatch}
                        onSeek={onSeek}
                    />
                ))}
            </div>
            {hidden > 0 ? (
                <div className="flex items-center justify-center gap-2 rounded-lg border border-white/8 p-2 text-xs">
                    <span className="text-muted-foreground">
                        First {DEFAULT_RENDER_LIMIT.toLocaleString()} of {filtered.length.toLocaleString()}
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
                        Show all
                    </Button>
                </div>
            ) : null}
        </div>
    );
}

function TranscriptRow({
    block,
    showRange,
    query,
    matchStarts,
    currentMatch,
    onSeek,
}: {
    block: TranscriptBlock;
    showRange: boolean;
    query: string;
    /** Global index of each paragraph's first search match. */
    matchStarts: number[];
    /** Global index of the currently focused match. */
    currentMatch: number;
    onSeek: (seconds: number) => void;
}) {
    const label = showRange
        ? `${formatTimecode(block.start)}–${formatTimecode(block.end)}`
        : formatTimecode(block.start);

    return (
        <article className="min-w-0 space-y-2">
            <button
                type="button"
                onClick={() => onSeek(block.start)}
                className="yt-timecode inline-flex h-6 items-center px-2 text-[12px] font-mono tabular-nums"
            >
                {label}
            </button>
            <div className="min-w-0 space-y-3">
                {block.paragraphs.map((paragraph, i) => (
                    <p
                        key={`${paragraph.start}-${i}`}
                        className="min-w-0 break-words text-sm leading-[1.65] text-foreground/85"
                    >
                        {highlight({
                            text: paragraph.text,
                            query,
                            matchStart: matchStarts[i] ?? 0,
                            currentMatch,
                            onAltSeek: () => onSeek(paragraph.start),
                        })}
                    </p>
                ))}
            </div>
        </article>
    );
}

function highlight({
    text,
    query,
    matchStart,
    currentMatch,
    onAltSeek,
}: {
    text: string;
    query: string;
    matchStart: number;
    currentMatch: number;
    onAltSeek: () => void;
}) {
    if (!query.trim()) {
        return text;
    }

    const parts = text.split(new RegExp(`(${escapeRegExp(query)})`, "ig"));
    let occurrence = 0;

    return parts.map((part, index) => {
        if (part.toLowerCase() !== query.toLowerCase()) {
            return part;
        }

        const globalIdx = matchStart + occurrence;
        occurrence += 1;
        const isCurrent = globalIdx === currentMatch;

        return (
            <mark
                key={index}
                data-match={globalIdx}
                onClick={(event) => {
                    // Alt-click seeks the video; plain navigation only scrolls.
                    if (event.altKey) {
                        event.preventDefault();
                        onAltSeek();
                    }
                }}
                className={
                    isCurrent
                        ? "rounded-sm bg-primary/30 px-1 text-foreground"
                        : "rounded bg-primary/30 px-1 text-primary-foreground"
                }
            >
                {part}
            </mark>
        );
    });
}

function countOccurrences(haystack: string, needle: string): number {
    if (!needle) {
        return 0;
    }

    let count = 0;
    let position = haystack.indexOf(needle);

    while (position !== -1) {
        count += 1;
        position = haystack.indexOf(needle, position + needle.length);
    }

    return count;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
