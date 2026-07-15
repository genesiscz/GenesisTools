import type { VideoLongSummary } from "@app/youtube/lib/types";
import { CheckCircle2, ChevronDown } from "lucide-react";
import { useState } from "react";

export interface LongSummaryViewProps {
    summary: VideoLongSummary;
}

export function LongSummaryView({ summary }: LongSummaryViewProps) {
    return (
        <div className="space-y-5">
            <section>
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-primary">TL;DR</p>
                <p className="mt-2 bg-gradient-to-r from-amber-200 via-amber-300 to-cyan-300 bg-clip-text text-lg font-medium leading-relaxed text-transparent">
                    {summary.tldr}
                </p>
            </section>

            {summary.keyPoints.length > 0 ? (
                <section>
                    <h4 className="font-mono text-[11px] uppercase tracking-[0.18em] text-secondary">Key points</h4>
                    <ol className="mt-2 space-y-2">
                        {summary.keyPoints.map((point, index) => (
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
            ) : null}

            {summary.learnings.length > 0 ? (
                <section>
                    <h4 className="font-mono text-[11px] uppercase tracking-[0.18em] text-emerald-300">Learnings</h4>
                    <ul className="mt-2 space-y-2">
                        {summary.learnings.map((point, index) => (
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
            ) : null}

            {summary.chapters.length > 0 ? (
                <section>
                    <h4 className="font-mono text-[11px] uppercase tracking-[0.18em] text-cyan-200">Chapters</h4>
                    <div className="mt-2 space-y-2">
                        {summary.chapters.map((chapter, index) => (
                            <ChapterCard key={index} title={chapter.title} summary={chapter.summary} />
                        ))}
                    </div>
                </section>
            ) : null}

            {summary.conclusion ? (
                <blockquote className="rounded-2xl border-l-4 border-amber-400/60 bg-amber-400/[0.05] p-4 text-sm italic leading-relaxed text-foreground/95">
                    {summary.conclusion}
                </blockquote>
            ) : null}
        </div>
    );
}

function ChapterCard({ title, summary }: { title: string; summary: string }) {
    const [expanded, setExpanded] = useState(false);

    return (
        <div className="overflow-hidden rounded-2xl border border-cyan-400/20 bg-cyan-400/[0.04]">
            <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="flex w-full items-center justify-between gap-3 p-3 text-left"
            >
                <h5 className="text-sm font-semibold text-foreground/95">{title}</h5>
                <ChevronDown
                    className={
                        expanded ? "size-4 rotate-180 text-cyan-200 transition" : "size-4 text-cyan-200/70 transition"
                    }
                />
            </button>
            {expanded ? (
                <p className="border-t border-cyan-400/15 p-3 text-sm leading-relaxed text-foreground/90">{summary}</p>
            ) : null}
        </div>
    );
}
