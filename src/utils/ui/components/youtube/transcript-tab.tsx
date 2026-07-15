import { Button } from "@app/utils/ui/components/button";
import { Input } from "@app/utils/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@app/utils/ui/components/select";
import { activeChapterIndex } from "@app/utils/ui/components/youtube/chapters";
import { LlmConfirmDialog } from "@app/utils/ui/components/youtube/llm-confirm-dialog";
import { Loading } from "@app/utils/ui/components/youtube/loading";
import { OUTPUT_LANGS, outputLangLabel } from "@app/utils/ui/components/youtube/output-langs";
import type { PipelineProgress, RunPipeline } from "@app/utils/ui/components/youtube/tabs";
import { formatTimecode } from "@app/utils/ui/components/youtube/time";
import { segmentsToParagraphs, type TranscriptParagraph } from "@app/utils/ui/components/youtube/transcript-paragraphs";
import type { Transcript, TranscriptSegment, Video, VideoId } from "@app/youtube/lib/types";
import { Captions, ChevronDown, ChevronUp, Languages, Loader2, LocateFixed, Search } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

/** Sentinel Select value meaning "no lang filter — server picks the default (captions preferred)". */
const ORIGINAL_LANG = "__original__";
const TRANSLATE_COST = 5;

const DEFAULT_RENDER_LIMIT = 200;
const DEFAULT_BUCKET_SEC = 120;
/** Manual wheel/touch scrolling pauses follow-mode auto-scroll for this long. */
const FOLLOW_GRACE_MS = 5000;
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
    ) => {
        data: { transcript: Transcript; speakerLabels?: Record<number, string> } | undefined;
        isPending: boolean;
    };
    useSetSpeakers: (id: VideoId) => {
        mutateAsync: (vars: {
            speakers: Array<{ idx: number; label: string }>;
        }) => Promise<{ speakerLabels?: Record<number, string> }>;
        isPending: boolean;
    };
    runPipeline?: RunPipeline;
    pipelineProgress?: PipelineProgress | null;
    /** Current playback second (1 Hz bridge) — drives follow mode. */
    playerTime?: number | null;
    /** Lists every stored transcript row (for the language Select) — reuses
     *  the video-detail hook's `transcripts` field. Optional; omit to hide
     *  the language Select entirely. */
    useVideo?: (id: VideoId | null) => {
        data: { video: Video; transcripts?: Transcript[] } | undefined;
        isPending: boolean;
    };
    /** Feature 08 Layer 2: AI-translates the transcript into another
     *  language. Optional; omit to hide "Translate to…" entries. */
    useTranslateTranscript?: (id: VideoId) => {
        mutateAsync: (vars: { lang: string }) => Promise<{ transcript: Transcript; creditsSpent: number }>;
        isPending: boolean;
        error?: Error | null;
    };
}

export function TranscriptTab({
    videoId,
    onSeek,
    useTranscript,
    useSetSpeakers,
    useVideo,
    useTranslateTranscript,
    runPipeline,
    pipelineProgress,
    playerTime,
}: TranscriptTabProps) {
    const [query, setQuery] = useState("");
    const [showAll, setShowAll] = useState(false);
    const [bucketSec, setBucketSec] = useState<number>(DEFAULT_BUCKET_SEC);
    const [currentMatch, setCurrentMatch] = useState(0);
    const [follow, setFollow] = useState(false);
    const [labelOverrides, setLabelOverrides] = useState<Record<number, string>>({});
    const [selectedLang, setSelectedLang] = useState<string | undefined>(undefined);
    const [translateTarget, setTranslateTarget] = useState<string | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const lastUserScrollAt = useRef(0);
    const transcript = useTranscript(videoId, { lang: selectedLang });
    const setSpeakers = useSetSpeakers(videoId);
    const video = useVideo?.(videoId);
    const translate = useTranslateTranscript?.(videoId);
    const existingLangs = useMemo(
        () => [...new Set((video?.data?.transcripts ?? []).map((row) => row.lang))],
        [video?.data?.transcripts]
    );
    const missingLangs = OUTPUT_LANGS.filter((entry) => !existingLangs.includes(entry.code));
    const segments = transcript.data?.transcript.segments ?? [];
    const serverLabels = transcript.data?.speakerLabels;
    const needle = query.trim().toLowerCase();

    async function confirmTranslate() {
        if (!translate || !translateTarget) {
            return;
        }

        await translate.mutateAsync({ lang: translateTarget });
        setSelectedLang(translateTarget);
        setTranslateTarget(null);
    }

    useEffect(() => {
        setLabelOverrides({});
    }, [videoId]);

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

    const activeBlockIndex = useMemo(() => {
        if (!follow || playerTime === null || playerTime === undefined || trimmed.length === 0) {
            return null;
        }

        return activeChapterIndex(
            trimmed.map((block) => block.start),
            playerTime
        );
    }, [follow, playerTime, trimmed]);

    useEffect(() => {
        if (activeBlockIndex === null) {
            return;
        }

        if (Date.now() - lastUserScrollAt.current < FOLLOW_GRACE_MS) {
            return;
        }

        scrollRef.current
            ?.querySelector(`[data-block="${activeBlockIndex}"]`)
            ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, [activeBlockIndex]);

    function labelForSpeaker(idx: number): string {
        return labelOverrides[idx] ?? serverLabels?.[idx] ?? `Speaker ${idx + 1}`;
    }

    function renameSpeaker(idx: number, label: string): void {
        const previous = labelOverrides[idx];
        // One map in state: every chip of this speaker updates instantly.
        setLabelOverrides((prev) => ({ ...prev, [idx]: label }));
        setSpeakers.mutateAsync({ speakers: [{ idx, label }] }).catch(() => {
            setLabelOverrides((prev) => {
                const next = { ...prev };

                if (previous === undefined) {
                    delete next[idx];
                } else {
                    next[idx] = previous;
                }

                return next;
            });
        });
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
                <div className="h-4 w-px bg-white/8" />
                <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Follow playback"
                    aria-pressed={follow}
                    className={follow ? "rounded-md bg-primary/10 text-primary" : undefined}
                    onClick={() => setFollow((value) => !value)}
                >
                    <LocateFixed className="size-4" />
                </Button>
                {useVideo ? (
                    <>
                        <div className="h-4 w-px bg-white/8" />
                        <Select
                            value={selectedLang ?? ORIGINAL_LANG}
                            onValueChange={(value) => {
                                const missing = missingLangs.find((entry) => entry.code === value);

                                if (missing) {
                                    setTranslateTarget(missing.code);
                                    return;
                                }

                                setSelectedLang(value === ORIGINAL_LANG ? undefined : value);
                            }}
                            disabled={translate?.isPending}
                        >
                            <SelectTrigger className="h-8 w-[150px] text-sm">
                                {translate?.isPending ? (
                                    <span className="flex items-center gap-1.5">
                                        <Loader2 className="size-3.5 animate-spin" /> Translating…
                                    </span>
                                ) : (
                                    <SelectValue />
                                )}
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={ORIGINAL_LANG}>
                                    <Languages className="size-3.5" /> Original
                                </SelectItem>
                                {existingLangs.map((code) => (
                                    <SelectItem key={code} value={code}>
                                        <span className="font-mono text-[12px] uppercase">{code}</span>{" "}
                                        {outputLangLabel(code)}
                                    </SelectItem>
                                ))}
                                {translate
                                    ? missingLangs.map((entry) => (
                                          <SelectItem key={entry.code} value={entry.code}>
                                              Translate to {entry.label} · {TRANSLATE_COST} 💎
                                          </SelectItem>
                                      ))
                                    : null}
                            </SelectContent>
                        </Select>
                    </>
                ) : null}
                <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
                    {segments.length.toLocaleString()} segments · {totalParagraphs.toLocaleString()} paragraphs
                </span>
            </div>
            <div
                ref={scrollRef}
                className="yt-scroll min-w-0 space-y-4 overflow-y-auto"
                onWheel={() => {
                    lastUserScrollAt.current = Date.now();
                }}
                onTouchMove={() => {
                    lastUserScrollAt.current = Date.now();
                }}
            >
                {trimmed.map((block, index) => (
                    <TranscriptRow
                        key={`${block.start}-${index}`}
                        block={block}
                        blockIndex={index}
                        active={index === activeBlockIndex}
                        showRange={bucketSec > 0}
                        query={needle}
                        matchStarts={matches.starts[index] ?? []}
                        currentMatch={currentMatch}
                        onSeek={onSeek}
                        previousSpeaker={index > 0 ? trimmed[index - 1].paragraphs.at(-1)?.speaker : undefined}
                        labelForSpeaker={labelForSpeaker}
                        onRenameSpeaker={renameSpeaker}
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
            {translate?.error ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-sm">
                    <p className="font-medium text-destructive">Translation failed</p>
                    <p className="mt-1 break-words text-destructive/80">{translate.error.message}</p>
                </div>
            ) : null}
            {translate ? (
                <LlmConfirmDialog
                    open={translateTarget !== null}
                    title="Translate transcript?"
                    description="Sends the transcript to your LLM, chunked with timestamps preserved, and translates it line by line."
                    payloadSummary={
                        translateTarget ? `Full transcript · target language ${outputLangLabel(translateTarget)}.` : ""
                    }
                    busy={translate.isPending}
                    confirmLabel={`Translate · ${TRANSLATE_COST} 💎`}
                    billingNote={`Cost: ${TRANSLATE_COST} 💎, charged once — cached for every future request.`}
                    error={translate.error ? translate.error.message : null}
                    onCancel={() => setTranslateTarget(null)}
                    onConfirm={confirmTranslate}
                />
            ) : null}
        </div>
    );
}

function SpeakerChip({ label, onRename }: { label: string; onRename: (label: string) => void }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(label);

    if (!editing) {
        return (
            <div>
                <button
                    type="button"
                    onClick={() => {
                        setDraft(label);
                        setEditing(true);
                    }}
                    className="inline-flex h-6 items-center rounded-full border border-white/8 bg-black/20 px-2 font-mono text-[12px]"
                >
                    {label}
                </button>
            </div>
        );
    }

    return (
        <div>
            <Input
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        const next = draft.trim();

                        if (next.length > 0 && next !== label) {
                            onRename(next);
                        }

                        setEditing(false);
                        return;
                    }

                    if (event.key === "Escape") {
                        event.preventDefault();
                        setEditing(false);
                    }
                }}
                onBlur={() => setEditing(false)}
                className="h-6 w-32 border-0 bg-transparent font-mono text-[12px]"
            />
        </div>
    );
}

function TranscriptRow({
    block,
    blockIndex,
    active,
    showRange,
    query,
    matchStarts,
    currentMatch,
    onSeek,
    previousSpeaker,
    labelForSpeaker,
    onRenameSpeaker,
}: {
    block: TranscriptBlock;
    blockIndex: number;
    /** True when follow mode marks this block as containing the playhead. */
    active: boolean;
    showRange: boolean;
    query: string;
    /** Global index of each paragraph's first search match. */
    matchStarts: number[];
    /** Global index of the currently focused match. */
    currentMatch: number;
    onSeek: (seconds: number) => void;
    /** Speaker of the last paragraph in the previous block, for chip boundaries. */
    previousSpeaker: number | undefined;
    labelForSpeaker: (idx: number) => string;
    onRenameSpeaker: (idx: number, label: string) => void;
}) {
    const label = showRange
        ? `${formatTimecode(block.start)}–${formatTimecode(block.end)}`
        : formatTimecode(block.start);

    return (
        <article
            data-block={blockIndex}
            className={
                // Follow-mode wash per the design capsule: subtle, no border.
                active ? "-mx-2 min-w-0 space-y-2 rounded-lg bg-primary/8 px-2 transition-colors" : "min-w-0 space-y-2"
            }
        >
            <button
                type="button"
                onClick={() => onSeek(block.start)}
                className="yt-timecode inline-flex h-6 items-center px-2 text-[12px] font-mono tabular-nums"
            >
                {label}
            </button>
            <div className="min-w-0 space-y-3">
                {block.paragraphs.map((paragraph, i) => {
                    const prevSpeaker = i > 0 ? block.paragraphs[i - 1].speaker : previousSpeaker;
                    const chipSpeaker =
                        paragraph.speaker !== undefined && paragraph.speaker !== prevSpeaker ? paragraph.speaker : null;

                    return (
                        <Fragment key={`${paragraph.start}-${i}`}>
                            {chipSpeaker !== null ? (
                                <SpeakerChip
                                    label={labelForSpeaker(chipSpeaker)}
                                    onRename={(nextLabel) => onRenameSpeaker(chipSpeaker, nextLabel)}
                                />
                            ) : null}
                            <p className="min-w-0 break-words text-sm leading-[1.65] text-foreground/85">
                                {highlight({
                                    text: paragraph.text,
                                    query,
                                    matchStart: matchStarts[i] ?? 0,
                                    currentMatch,
                                    onAltSeek: () => onSeek(paragraph.start),
                                })}
                            </p>
                        </Fragment>
                    );
                })}
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
