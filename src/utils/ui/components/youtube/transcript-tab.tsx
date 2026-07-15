import { Button } from "@app/utils/ui/components/button";
import { Input } from "@app/utils/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@app/utils/ui/components/select";
import { Loading } from "@app/utils/ui/components/youtube/loading";
import type { RunPipeline } from "@app/utils/ui/components/youtube/tabs";
import { formatTimecode } from "@app/utils/ui/components/youtube/time";
import { segmentsToParagraphs, type TranscriptParagraph } from "@app/utils/ui/components/youtube/transcript-paragraphs";
import type { Transcript, TranscriptSegment, VideoId } from "@app/youtube/lib/types";
import { Captions, Search } from "lucide-react";
import { useMemo, useState } from "react";

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
}

export function TranscriptTab({ videoId, onSeek, useTranscript, runPipeline }: TranscriptTabProps) {
    const [query, setQuery] = useState("");
    const [showAll, setShowAll] = useState(false);
    const [bucketSec, setBucketSec] = useState<number>(DEFAULT_BUCKET_SEC);
    const transcript = useTranscript(videoId);
    const segments = transcript.data?.transcript.segments ?? [];

    const blocks = useMemo(() => bucketSegments(segments, bucketSec), [segments, bucketSec]);

    const filtered = useMemo(() => {
        if (!query.trim()) {
            return blocks;
        }

        const needle = query.toLowerCase();
        return blocks.filter((block) => block.paragraphs.some((p) => p.text.toLowerCase().includes(needle)));
    }, [blocks, query]);

    const trimmed = useMemo(() => {
        if (showAll || query.trim() || filtered.length <= DEFAULT_RENDER_LIMIT) {
            return filtered;
        }

        return filtered.slice(0, DEFAULT_RENDER_LIMIT);
    }, [filtered, showAll, query]);

    if (transcript.isPending) {
        return <Loading label="Loading transcript" />;
    }

    if (segments.length === 0) {
        const isRunning = runPipeline?.isPending ?? false;

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
                            {isRunning ? "Fetching transcript…" : "Fetch transcript"}
                        </Button>
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
                        placeholder="Search"
                        className="h-8 pl-8 text-xs"
                    />
                </div>
                <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
                    {segments.length.toLocaleString()} segments · {totalParagraphs.toLocaleString()} paragraphs
                </span>
            </div>
            <div className="yt-scroll min-w-0 space-y-4 overflow-y-auto">
                {trimmed.map((block, index) => (
                    <TranscriptRow
                        key={`${block.start}-${index}`}
                        block={block}
                        showRange={bucketSec > 0}
                        query={query}
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
    onSeek,
}: {
    block: TranscriptBlock;
    showRange: boolean;
    query: string;
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
                        {highlight(paragraph.text, query)}
                    </p>
                ))}
            </div>
        </article>
    );
}

function highlight(text: string, query: string) {
    if (!query.trim()) {
        return text;
    }

    const parts = text.split(new RegExp(`(${escapeRegExp(query)})`, "ig"));

    return parts.map((part, index) =>
        part.toLowerCase() === query.toLowerCase() ? (
            <mark key={index} className="rounded bg-primary/30 px-1 text-primary-foreground">
                {part}
            </mark>
        ) : (
            part
        )
    );
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
