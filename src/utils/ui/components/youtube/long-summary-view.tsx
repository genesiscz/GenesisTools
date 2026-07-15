import { activeChapterIndex } from "@app/utils/ui/components/youtube/chapters";
import type { PartialLongSummary } from "@app/utils/ui/components/youtube/summary-partials";
import { formatTimecode } from "@app/utils/ui/components/youtube/time";
import { CheckCircle2, ChevronDown } from "lucide-react";
import { useState } from "react";

export interface LongSummaryViewProps {
    /** Final `VideoLongSummary` or a streamed partial of it — every field may be missing. */
    summary: PartialLongSummary;
    /** True while the summary is still streaming in — pending sections render skeleton blocks. */
    streaming?: boolean;
    /** Seeks the player; enables the chapter timecode pills. */
    onSeek?: (sec: number) => void;
    /** Current playback second (1 Hz bridge) — drives the "playing" chapter state. */
    playerTime?: number | null;
}

interface DisplayChapter {
    title: string;
    summary?: string;
    startSec?: number;
}

export function LongSummaryView({ summary, streaming, onSeek, playerTime }: LongSummaryViewProps) {
    const keyPoints = (summary.keyPoints ?? []).filter(
        (point): point is string => typeof point === "string" && point.length > 0
    );
    const learnings = (summary.learnings ?? []).filter(
        (point): point is string => typeof point === "string" && point.length > 0
    );
    const chapters = (summary.chapters ?? []).filter(
        (chapter): chapter is DisplayChapter =>
            chapter !== undefined && typeof chapter.title === "string" && chapter.title.length > 0
    );
    const timedChapters = chapters
        .filter((chapter): chapter is DisplayChapter & { startSec: number } => typeof chapter.startSec === "number")
        .sort((a, b) => a.startSec - b.startSec);
    const activeTimedIndex =
        playerTime !== null && playerTime !== undefined && timedChapters.length > 0
            ? activeChapterIndex(
                  timedChapters.map((chapter) => chapter.startSec),
                  playerTime
              )
            : null;
    const activeChapter = activeTimedIndex === null ? null : timedChapters[activeTimedIndex];

    return (
        <div className="space-y-5">
            <section>
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-primary">TL;DR</p>
                {summary.tldr ? (
                    <p className="mt-2 bg-gradient-to-r from-amber-200 via-amber-300 to-cyan-300 bg-clip-text text-lg font-medium leading-relaxed text-transparent">
                        {summary.tldr}
                    </p>
                ) : streaming ? (
                    <SkeletonLines count={2} />
                ) : null}
            </section>

            {keyPoints.length > 0 ? (
                <section>
                    <h4 className="font-mono text-[11px] uppercase tracking-[0.18em] text-secondary">Key points</h4>
                    <ol className="mt-2 space-y-2">
                        {keyPoints.map((point, index) => (
                            <li
                                key={index}
                                className="flex gap-3 rounded-2xl border border-secondary/20 bg-secondary/5 p-3"
                            >
                                <span className="font-mono text-xs font-bold leading-6 text-secondary">
                                    {(index + 1).toString().padStart(2, "0")}
                                </span>
                                <span className="text-sm leading-relaxed text-foreground/95">{point}</span>
                            </li>
                        ))}
                    </ol>
                </section>
            ) : streaming ? (
                <PendingSection label="Key points" labelClass="text-secondary" />
            ) : null}

            {learnings.length > 0 ? (
                <section>
                    <h4 className="font-mono text-[11px] uppercase tracking-[0.18em] text-emerald-300">Learnings</h4>
                    <ul className="mt-2 space-y-2">
                        {learnings.map((point, index) => (
                            <li
                                key={index}
                                className="flex items-start gap-3 rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.05] p-3"
                            >
                                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-300" />
                                <span className="text-sm leading-relaxed text-foreground/95">{point}</span>
                            </li>
                        ))}
                    </ul>
                </section>
            ) : streaming ? (
                <PendingSection label="Learnings" labelClass="text-emerald-300" />
            ) : null}

            {chapters.length > 0 ? (
                <section>
                    <h4 className="font-mono text-[11px] uppercase tracking-[0.18em] text-cyan-200">Chapters</h4>
                    <div className="mt-2 space-y-2">
                        {chapters.map((chapter, index) => (
                            <ChapterCard
                                key={
                                    typeof chapter.startSec === "number"
                                        ? `t-${chapter.startSec}`
                                        : `${index}-${chapter.title}`
                                }
                                title={chapter.title}
                                summary={chapter.summary}
                                streaming={streaming}
                                startSec={chapter.startSec}
                                active={activeChapter !== null && chapter === activeChapter}
                                onSeek={onSeek}
                            />
                        ))}
                    </div>
                </section>
            ) : streaming ? (
                <PendingSection label="Chapters" labelClass="text-cyan-200" />
            ) : null}

            {summary.conclusion ? (
                <blockquote className="rounded-2xl border-l-4 border-amber-400/60 bg-amber-400/[0.05] p-4 text-sm italic leading-relaxed text-foreground/95">
                    {summary.conclusion}
                </blockquote>
            ) : null}
        </div>
    );
}

function SkeletonLines({ count }: { count: number }) {
    return (
        <div className="mt-2 space-y-2">
            {Array.from({ length: count }).map((_, index) => (
                <div key={index} className="h-4 rounded-md bg-muted animate-pulse" />
            ))}
        </div>
    );
}

function PendingSection({ label, labelClass }: { label: string; labelClass: string }) {
    return (
        <section>
            <h4 className={`font-mono text-[11px] uppercase tracking-[0.18em] ${labelClass}`}>{label}</h4>
            <SkeletonLines count={3} />
        </section>
    );
}

interface ChapterCardProps {
    title: string;
    summary?: string;
    streaming?: boolean;
    startSec?: number;
    active?: boolean;
    onSeek?: (sec: number) => void;
}

function ChapterCard({ title, summary, streaming, startSec, active, onSeek }: ChapterCardProps) {
    const [expanded, setExpanded] = useState(false);
    const cardClass = active
        ? "overflow-hidden rounded-2xl border border-primary/40 bg-cyan-400/[0.04] transition-colors"
        : "overflow-hidden rounded-2xl border border-cyan-400/20 bg-cyan-400/[0.04] transition-colors";
    const timecodePill =
        typeof startSec === "number" && onSeek ? (
            <button
                type="button"
                onClick={() => onSeek(startSec)}
                className="yt-timecode inline-flex h-6 items-center px-2 font-mono text-[12px] tabular-nums"
            >
                {formatTimecode(startSec)}
            </button>
        ) : null;

    if (!summary) {
        // Truncated tail of a streamed chapter list: title landed, body still writing.
        return (
            <div className={`${cardClass} p-3`}>
                <div className="flex items-center gap-3">
                    {timecodePill}
                    <h5 className="text-sm font-semibold text-foreground/95">{title}</h5>
                </div>
                {streaming ? <div className="mt-2 h-4 rounded-md bg-muted animate-pulse" /> : null}
            </div>
        );
    }

    return (
        <div className={cardClass}>
            <div className="flex w-full items-center gap-3 p-3">
                {timecodePill}
                <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
                >
                    <h5 className="text-sm font-semibold text-foreground/95">{title}</h5>
                    <span className="flex shrink-0 items-center gap-2">
                        {active ? (
                            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-primary">
                                playing
                            </span>
                        ) : null}
                        <ChevronDown
                            className={
                                expanded
                                    ? "size-4 rotate-180 text-cyan-200 transition"
                                    : "size-4 text-cyan-200/70 transition"
                            }
                        />
                    </span>
                </button>
            </div>
            {expanded ? (
                <p className="border-t border-cyan-400/15 p-3 text-sm leading-relaxed text-foreground/90">{summary}</p>
            ) : null}
        </div>
    );
}
