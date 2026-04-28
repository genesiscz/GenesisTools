import { Button } from "@app/utils/ui/components/button";
import { Input } from "@app/utils/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@app/utils/ui/components/select";
import { Loading } from "@app/utils/ui/components/youtube/loading";
import type { RunPipeline } from "@app/utils/ui/components/youtube/tabs";
import { formatTimecode } from "@app/utils/ui/components/youtube/time";
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
    text: string;
}

function bucketSegments(segments: TranscriptSegment[], bucketSec: number): TranscriptBlock[] {
    if (bucketSec <= 0 || segments.length === 0) {
        return segments.map((segment) => ({
            start: segment.start,
            end: segment.end,
            text: segment.text.trim(),
        }));
    }

    const blocks: TranscriptBlock[] = [];
    let current: TranscriptBlock | null = null;
    let bucketBoundary = 0;

    for (const segment of segments) {
        if (!current || segment.start >= bucketBoundary) {
            if (current) {
                blocks.push(current);
            }

            const blockStart = Math.floor(segment.start / bucketSec) * bucketSec;
            bucketBoundary = blockStart + bucketSec;
            current = { start: blockStart, end: segment.end, text: segment.text.trim() };

            continue;
        }

        current.end = segment.end;
        const trimmed = segment.text.trim();

        if (trimmed.length === 0) {
            continue;
        }

        const sep = current.text.endsWith(".") || current.text.endsWith("?") || current.text.endsWith("!") ? " " : " ";
        current.text = `${current.text}${sep}${trimmed}`;
    }

    if (current) {
        blocks.push(current);
    }

    return blocks;
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
        return blocks.filter((block) => block.text.toLowerCase().includes(needle));
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

    return (
        <div className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <p className="font-mono text-xs uppercase tracking-[0.28em] text-secondary">Transcript</p>
                    <h3 className="mt-2 text-2xl font-bold">Searchable timecodes</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                        {segments.length.toLocaleString()} segments · {blocks.length.toLocaleString()} block
                        {blocks.length === 1 ? "" : "s"} · {transcript.data?.transcript.source ?? "captions"}
                    </p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <Select value={String(bucketSec)} onValueChange={(value) => setBucketSec(Number(value))}>
                        <SelectTrigger className="sm:w-[140px]">
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
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder="Search transcript"
                            className="pl-9 sm:w-64"
                        />
                    </div>
                </div>
            </div>
            <div className="yt-scroll max-h-[62vh] space-y-2 overflow-auto pr-2">
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
                <div className="flex items-center justify-center gap-3 rounded-2xl border border-dashed border-primary/30 bg-primary/5 p-3 text-sm">
                    <span className="text-muted-foreground">
                        Showing first {DEFAULT_RENDER_LIMIT.toLocaleString()} of {filtered.length.toLocaleString()}{" "}
                        blocks.
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
                        Show all {filtered.length.toLocaleString()}
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
        <article className="grid gap-3 rounded-2xl border border-primary/15 bg-black/20 p-3 sm:grid-cols-[7.5rem_1fr]">
            <Button
                variant="ghost"
                size="sm"
                className="yt-timecode h-8 justify-self-start whitespace-nowrap"
                onClick={() => onSeek(block.start)}
            >
                {label}
            </Button>
            <p className="leading-7 text-foreground/90">{highlight(block.text, query)}</p>
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
