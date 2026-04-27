import { useMemo, useState } from "react";
import { Button } from "@app/utils/ui/components/button";
import { Input } from "@app/utils/ui/components/input";
import { Loading } from "@app/utils/ui/components/youtube/loading";
import { formatTimecode } from "@app/utils/ui/components/youtube/time";
import type { Transcript, TranscriptSegment, VideoId } from "@app/youtube/lib/types";
import { Search } from "lucide-react";

export interface TranscriptTabProps {
    videoId: VideoId;
    onSeek: (seconds: number) => void;
    useTranscript: (id: VideoId | null, opts?: { lang?: string; source?: "captions" | "ai" }) => { data: { transcript: Transcript } | undefined; isPending: boolean };
}

export function TranscriptTab({ videoId, onSeek, useTranscript }: TranscriptTabProps) {
    const [query, setQuery] = useState("");
    const transcript = useTranscript(videoId);
    const segments = transcript.data?.transcript.segments ?? [];
    const filtered = useMemo(() => {
        if (!query.trim()) {
            return segments;
        }

        return segments.filter((segment) => segment.text.toLowerCase().includes(query.toLowerCase()));
    }, [segments, query]);

    if (transcript.isPending) {
        return <Loading label="Loading transcript" />;
    }

    return (
        <div className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <p className="font-mono text-xs uppercase tracking-[0.28em] text-secondary">Transcript</p>
                    <h3 className="mt-2 text-2xl font-bold">Searchable timecodes</h3>
                </div>
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search transcript" className="pl-9 sm:w-64" />
                </div>
            </div>
            <div className="yt-scroll max-h-[62vh] space-y-2 overflow-auto pr-2">
                {filtered.map((segment, index) => <TranscriptRow key={`${segment.start}-${index}`} segment={segment} query={query} onSeek={onSeek} />)}
            </div>
        </div>
    );
}

function TranscriptRow({ segment, query, onSeek }: { segment: TranscriptSegment; query: string; onSeek: (seconds: number) => void }) {
    return (
        <article className="grid gap-3 rounded-2xl border border-primary/15 bg-black/20 p-3 sm:grid-cols-[5.5rem_1fr]">
            <Button variant="ghost" size="sm" className="yt-timecode h-8" onClick={() => onSeek(segment.start)}>
                {formatTimecode(segment.start)}
            </Button>
            <p className="leading-7 text-foreground/90">{highlight(segment.text, query)}</p>
        </article>
    );
}

function highlight(text: string, query: string) {
    if (!query.trim()) {
        return text;
    }

    const parts = text.split(new RegExp(`(${escapeRegExp(query)})`, "ig"));

    return parts.map((part, index) => part.toLowerCase() === query.toLowerCase() ? <mark key={index} className="rounded bg-primary/30 px-1 text-primary-foreground">{part}</mark> : part);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
