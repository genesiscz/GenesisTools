import { logger } from "@app/logger";
import { type CallLLMStructuredResult, callLLM, callLLMStructured } from "@app/utils/ai/call-llm";
import { Summarizer } from "@app/utils/ai/tasks/Summarizer";
import { resolveAiSpecForTask } from "@app/youtube/lib/ai-mapping";
import type { YoutubeConfig } from "@app/youtube/lib/config";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import { englishLanguageName } from "@app/youtube/lib/languages";
import { createPartialThrottle, type PartialThrottle } from "@app/youtube/lib/partial-throttle";
import { buildPresetBlock } from "@app/youtube/lib/presets";
import type { SummarizeOpts, SummarizeResult, SummaryBin, SummaryServiceDeps } from "@app/youtube/lib/summarize.types";
import type { Transcript } from "@app/youtube/lib/transcript.types";
import { compactTranscript } from "@app/youtube/lib/transcript-compact";
import { identifyProviderChoice, recordYoutubeUsage } from "@app/youtube/lib/usage";
import type {
    SummaryLength,
    SummaryTone,
    TimestampedSummaryEntry,
    VideoLongSummary,
    VideoLongSummaryChapter,
    VideoReport,
} from "@app/youtube/lib/video.types";
import type { ProviderChoice } from "@ask/types";
import { z } from "zod";

const DEFAULT_SUMMARY_DEPS: SummaryServiceDeps = {
    createSummarizer: (opts) => Summarizer.create(opts),
    callLLM,
    callLLMStructured,
};

const SHORT_SUMMARY_SYSTEM_BASE =
    "You summarise YouTube transcripts concisely. Reply with a 3-6 sentence summary covering the main points. No markdown, no preamble, no headings.";

const TIMESTAMPED_SYSTEM_BASE =
    "You read YouTube transcripts and produce timestamped section summaries. Each section is 3-15 minutes long. Each section has a single emoji icon, a 3-6 word title, and a 1-2 sentence body. Cover the entire video, in order. Do not invent content not in the transcript.";

const TIMESTAMPED_QA_SYSTEM_BASE =
    "You read YouTube transcripts and produce timestamped Q&A sections. Each section is 3-15 minutes long, with a single emoji icon, a short title, a clear question (1 sentence), and an answer text (1-2 sentences) drawn from that part of the transcript. Cover the entire video, in order.";

const LONG_SUMMARY_SYSTEM_BASE =
    "You write rich long-form summaries of YouTube videos. Use the supplied transcript and produce: a TL;DR, key points, learnings the viewer should walk away with, a topical chapter breakdown, and a closing verdict. Be concrete — name specific products, numbers, people. Do not invent facts.";

const TONE_INSTRUCTIONS: Record<SummaryTone, string> = {
    insightful:
        "Tone: insightful. Surface the underlying logic and tradeoffs the speaker makes. Be analytical and precise.",
    funny: "Tone: funny. Lean into observational humour. Keep it light but accurate. Do not insult anyone.",
    actionable:
        "Tone: actionable. Lead each section with the move-or-decision the viewer can take. Use imperative verbs.",
    controversial:
        "Tone: controversial. Highlight where the speaker's claims are debatable, surprising, or counter to mainstream opinion.",
};

const TimestampedListSectionSchema = z.object({
    startSec: z.number().int().nonnegative(),
    endSec: z.number().int().positive(),
    icon: z.string().min(1).max(8).describe("A single contextual emoji."),
    title: z.string().min(1).max(80).describe("3-6 word headline."),
    text: z.string().min(1).describe("1-2 sentence body."),
});

const TimestampedQaSectionSchema = z.object({
    startSec: z.number().int().nonnegative(),
    endSec: z.number().int().positive(),
    icon: z.string().min(1).max(8).describe("A single contextual emoji."),
    title: z.string().min(1).max(80).describe("3-6 word headline."),
    question: z.string().min(3).describe("Clear, 1-sentence question."),
    text: z.string().min(1).describe("1-2 sentence answer drawn from the transcript."),
});

const TimestampedListSchema = z.object({
    tldr: z.string().min(1).describe("2-3 sentence top-line summary of the whole video."),
    sections: z.array(TimestampedListSectionSchema).min(1).describe("Ordered, contiguous-ish 3-15 min sections."),
});

const TimestampedQaSchema = z.object({
    tldr: z.string().min(1).describe("2-3 sentence top-line summary of the whole video."),
    sections: z.array(TimestampedQaSectionSchema).min(1).describe("Ordered Q&A sections, 3-15 min each."),
});

const REPORT_SYSTEM_BASE =
    "You synthesize a structured report across MULTIPLE YouTube videos from their long-form summaries. Find shared themes, real disagreements between videos, per-video capsules, and a watch/skip recommendation. Reference videos by their ids exactly as given. Do not invent content beyond the summaries.";

const ReportSchema = z.object({
    overview: z.string().min(1).describe("3-6 sentence synthesis across all covered videos."),
    themes: z
        .array(
            z.object({
                title: z.string().min(1).max(80),
                detail: z.string().min(1),
                videoIds: z.array(z.string()).describe("Ids of the videos this theme draws on."),
            })
        )
        .min(1)
        .max(8),
    perVideo: z.array(
        z.object({
            videoId: z.string(),
            capsule: z.string().min(1).describe("2-3 sentence capsule of this video's contribution."),
            standout: z.string().min(1).describe("The single most memorable point of this video."),
        })
    ),
    disagreements: z
        .array(z.object({ topic: z.string().min(1), positions: z.string().min(1) }))
        .describe("Real contradictions between videos; empty when none."),
    recommendation: z.string().min(1).describe("Closing watch/skip verdict across the set."),
});

/** One video's input into a multi-video report synthesis. */
export interface ReportMember {
    videoId: string;
    title: string;
    uploadDate: string | null;
    summary: VideoLongSummary | null;
    /** Reason the member has no summary (no captions, region lock, …); null when covered. */
    skipped: string | null;
}

const LongSchema = z.object({
    tldr: z.string().min(1).describe("2-3 sentences capturing the essence of the video."),
    keyPoints: z.array(z.string().min(1)).min(3).max(10).describe("3-10 bullet points."),
    learnings: z.array(z.string().min(1)).min(2).max(8).describe("2-8 takeaways."),
    chapters: z
        .array(
            z.object({
                title: z.string().min(1).max(80),
                summary: z.string().min(1),
                startSec: z
                    .number()
                    .int()
                    .nonnegative()
                    .describe("Second in the transcript where this chapter's topic begins."),
                endSec: z
                    .number()
                    .int()
                    .positive()
                    .nullable()
                    .describe("Second where the topic ends, or null when open-ended."),
            })
        )
        .min(1)
        .max(12)
        .describe("Topical breakdown, each chapter anchored to the transcript's timestamps."),
    conclusion: z.string().nullable().describe("Closing verdict, or null."),
});

export class SummaryService {
    constructor(
        private readonly db: YoutubeDatabase,
        private readonly config: YoutubeConfig,
        private readonly deps: SummaryServiceDeps = DEFAULT_SUMMARY_DEPS
    ) {}

    async summarize(opts: SummarizeOpts): Promise<SummarizeResult> {
        const video = this.db.getVideo(opts.videoId);

        if (!video) {
            throw new Error(`unknown video: ${opts.videoId}`);
        }

        const transcriptRaw = this.db.getTranscript(opts.videoId);

        if (!transcriptRaw) {
            throw new Error(`no transcript for video ${opts.videoId}; transcribe first`);
        }

        const transcript = compactTranscript(transcriptRaw, { mergeSentences: true, ...(opts.compactOpts ?? {}) });

        const defaultShaping = isDefaultShaping(opts);

        if (opts.mode === "short") {
            if (
                !opts.forceRecompute &&
                video.summaryShort &&
                sameLang(video.summaryShortLang, opts.lang) &&
                defaultShaping
            ) {
                return { short: video.summaryShort };
            }

            const { summary, langUsed } = await this.summarizeText(transcript.text, opts);

            if (defaultShaping) {
                this.db.setVideoSummary(opts.videoId, "short", summary, langUsed);
            }

            return { short: summary };
        }

        if (opts.mode === "long") {
            if (
                !opts.forceRecompute &&
                video.summaryLong &&
                sameLang(video.summaryLongLang, opts.lang) &&
                defaultShaping
            ) {
                return { long: video.summaryLong };
            }

            const long = await this.summarizeLong(transcript, opts);

            if (defaultShaping) {
                this.db.setVideoSummary(opts.videoId, "long", long, opts.lang ?? "en");
            }

            return { long };
        }

        if (
            !opts.forceRecompute &&
            video.summaryTimestamped &&
            sameLang(video.summaryTimestampedLang, opts.lang) &&
            defaultShaping
        ) {
            return { timestamped: video.summaryTimestamped };
        }

        const timestamped = await this.summarizeTimestamped(transcript, opts);

        if (defaultShaping) {
            this.db.setVideoSummary(opts.videoId, "timestamped", timestamped, opts.lang ?? "en");
        }

        return { timestamped };
    }

    /**
     * Produces the short summary and reports the language actually used.
     * The `providerChoice` path honours `opts.lang` via the system prompt; the
     * legacy `createSummarizer` fallback has no language/tone knob (its API is
     * `summarize(text)` only), so it always emits English default-shaped prose —
     * hence `langUsed: "en"` there, so the caller never mis-tags a stored
     * artifact with a language it wasn't generated in.
     */
    private async summarizeText(text: string, opts: SummarizeOpts): Promise<{ summary: string; langUsed: string }> {
        opts.onProgress?.({ phase: "summarize", percent: 30, message: "Calling LLM for short summary" });
        const systemPrompt = withPreset(
            withLang(withTone(SHORT_SUMMARY_SYSTEM_BASE, opts.tone), opts.lang),
            opts.presetInstructions
        );

        if (opts.providerChoice) {
            const startedAt = new Date();
            const result = await this.deps.callLLM({
                systemPrompt,
                userPrompt: text,
                providerChoice: opts.providerChoice,
                streaming: false,
            });
            const completedAt = new Date();
            const ids = identifyProviderChoice(opts.providerChoice);
            await recordYoutubeUsage({
                action: "summarize:short",
                provider: ids.provider,
                model: ids.model,
                usage: result.usage,
                scope: opts.videoId,
                videoId: opts.videoId,
                prompt: formatPrompt(systemPrompt, text),
                response: result.content,
                durationMs: completedAt.getTime() - startedAt.getTime(),
                startedAt: startedAt.toISOString(),
                completedAt: completedAt.toISOString(),
            });

            return { summary: result.content, langUsed: opts.lang ?? "en" };
        }

        const configuredSpec = resolveAiSpecForTask(await this.config.getAll(), "summary");
        const providerName = opts.provider ?? configuredSpec ?? "default";
        const summarizer = await this.deps.createSummarizer({ provider: opts.provider ?? configuredSpec ?? undefined });

        try {
            const result = await summarizer.summarize(text);
            await recordYoutubeUsage({
                action: "summarize:short",
                provider: providerName,
                model: "(summarizer-default)",
                scope: opts.videoId,
                videoId: opts.videoId,
            });

            return { summary: result.summary, langUsed: "en" };
        } finally {
            summarizer.dispose();
        }
    }

    private async summarizeTimestamped(
        transcript: Transcript,
        opts: SummarizeOpts
    ): Promise<TimestampedSummaryEntry[]> {
        if (!opts.providerChoice) {
            throw new Error(
                "timestamped summary requires an LLM provider — pass providerChoice (CLI: --provider/--model, UI: dialog overrides)"
            );
        }

        const totalSec = transcript.durationSec ?? transcript.segments.at(-1)?.end ?? 0;
        const sectionCount = pickSectionCount(totalSec, { override: opts.targetBins, length: opts.length });
        const isQa = opts.format === "qa";
        const baseSystem = isQa ? TIMESTAMPED_QA_SYSTEM_BASE : TIMESTAMPED_SYSTEM_BASE;
        const systemPrompt = withPreset(withLang(withTone(baseSystem, opts.tone), opts.lang), opts.presetInstructions);
        const formattedTranscript = formatTranscriptWithTimestamps(transcript);
        const userPrompt = [
            `Build a timestamped section summary of this YouTube video.`,
            `Total duration: ${formatTime(totalSec)} (${Math.max(0, Math.round(totalSec))} seconds).`,
            `Produce exactly ${sectionCount} sections. Each section MUST be between 3 and 15 minutes long.`,
            isQa
                ? `Each section is a Q&A pair: a clear question + 1-2 sentence answer drawn from that part of the transcript.`
                : `Each section has an icon (single emoji), a 3-6 word title, and a 1-2 sentence body.`,
            `Times must be within [0, ${Math.max(0, Math.round(totalSec))}] seconds. Sections must be in time order.`,
            `Also output a top-level "tldr" — 2-3 sentences capturing the essence of the whole video.`,
            ``,
            `Transcript (each line prefixed with [MM:SS]):`,
            formattedTranscript,
        ].join("\n");

        opts.onProgress?.({
            phase: "summarize",
            percent: 30,
            message: `Calling LLM for ${sectionCount} timestamped sections (${isQa ? "qa" : "list"} format)`,
        });
        const startedAt = new Date();
        const throttle = createSummaryPartialThrottle(opts.onPartial);
        let result: CallLLMStructuredResult<unknown>;

        try {
            result = isQa
                ? await this.deps.callLLMStructured({
                      systemPrompt,
                      userPrompt,
                      providerChoice: opts.providerChoice,
                      schema: TimestampedQaSchema,
                      ...(throttle ? { onPartial: (partial: unknown) => throttle.push(partial) } : {}),
                  })
                : await this.deps.callLLMStructured({
                      systemPrompt,
                      userPrompt,
                      providerChoice: opts.providerChoice,
                      schema: TimestampedListSchema,
                      ...(throttle ? { onPartial: (partial: unknown) => throttle.push(partial) } : {}),
                  });
        } catch (error) {
            // A thrown call must not leave a queued partial to fire later.
            throttle?.cancel();
            throw error;
        }

        throttle?.flush();
        opts.onProgress?.({ phase: "summarize", percent: 90, message: "Parsing timestamped sections" });
        const completedAt = new Date();
        const ids = identifyProviderChoice(opts.providerChoice);
        await recordYoutubeUsage({
            action: "summarize:timestamped",
            provider: ids.provider,
            model: ids.model,
            usage: result.usage,
            scope: opts.videoId,
            videoId: opts.videoId,
            prompt: formatPrompt(systemPrompt, userPrompt),
            response: result.content,
            durationMs: completedAt.getTime() - startedAt.getTime(),
            startedAt: startedAt.toISOString(),
            completedAt: completedAt.toISOString(),
        });

        const sections = (result.object as { sections: TimestampedSummaryEntry[] }).sections;
        return clampSections(sections, totalSec);
    }

    private async summarizeLong(transcript: Transcript, opts: SummarizeOpts): Promise<VideoLongSummary> {
        if (!opts.providerChoice) {
            throw new Error(
                "long summary requires an LLM provider — pass providerChoice (CLI: --provider/--model, UI: dialog overrides)"
            );
        }

        const totalSec = transcript.durationSec ?? transcript.segments.at(-1)?.end ?? 0;
        const systemPrompt = withPreset(
            withLang(withTone(withLength(LONG_SUMMARY_SYSTEM_BASE, opts.length), opts.tone), opts.lang),
            opts.presetInstructions
        );
        const userPrompt = [
            `Write a rich long-form summary of this YouTube video.`,
            `Total duration: ${formatTime(totalSec)}.`,
            `Use only what is in the transcript. Be specific (numbers, products, names).`,
            `Anchor every chapter to the transcript's timestamps: startSec is the second where the chapter's topic begins (endSec where it ends, or null). Times must be within [0, ${Math.max(0, Math.round(totalSec))}] seconds and ascending.`,
            ``,
            `Transcript (each line prefixed with [MM:SS]):`,
            formatTranscriptWithTimestamps(transcript),
        ].join("\n");

        opts.onProgress?.({
            phase: "summarize",
            percent: 30,
            message: "Calling LLM for long-form summary (structured output)",
        });
        const startedAt = new Date();
        const throttle = createSummaryPartialThrottle(opts.onPartial);
        let result: CallLLMStructuredResult<unknown>;

        try {
            result = await this.deps.callLLMStructured({
                systemPrompt,
                userPrompt,
                providerChoice: opts.providerChoice,
                schema: LongSchema,
                ...(throttle ? { onPartial: (partial: unknown) => throttle.push(partial) } : {}),
            });
        } catch (error) {
            // A thrown call must not leave a queued partial to fire later.
            throttle?.cancel();
            throw error;
        }

        throttle?.flush();
        opts.onProgress?.({ phase: "summarize", percent: 90, message: "Parsing long-form structured response" });
        const completedAt = new Date();
        const ids = identifyProviderChoice(opts.providerChoice);
        await recordYoutubeUsage({
            action: "summarize:long",
            provider: ids.provider,
            model: ids.model,
            usage: result.usage,
            scope: opts.videoId,
            videoId: opts.videoId,
            prompt: formatPrompt(systemPrompt, userPrompt),
            response: result.content,
            durationMs: completedAt.getTime() - startedAt.getTime(),
            startedAt: startedAt.toISOString(),
            completedAt: completedAt.toISOString(),
        });

        const long = result.object as VideoLongSummary;

        return { ...long, chapters: clampChapters(long.chapters, totalSec) };
    }

    /**
     * `reportSynthesize` stage core: one structured synthesis over member LONG
     * summaries only (never raw transcripts). Members without a summary are
     * NEVER sent to the LLM and land in the result as `skipped: "<reason>"`.
     */
    async synthesizeReport(opts: {
        members: ReportMember[];
        providerChoice?: ProviderChoice;
        onProgress?: (info: { percent?: number; message: string }) => void;
    }): Promise<VideoReport> {
        if (!opts.providerChoice) {
            throw new Error("report synthesis requires an LLM provider — pass providerChoice");
        }

        const covered = opts.members.filter(
            (member): member is ReportMember & { summary: VideoLongSummary } => member.summary !== null
        );
        const skipped = opts.members.filter((member) => member.summary === null);

        if (covered.length === 0) {
            throw new Error("report synthesis: no member has a long summary — nothing to synthesize");
        }

        const userPrompt = [
            `Synthesize a report over ${covered.length} video summaries.`,
            ...(skipped.length > 0
                ? [`${skipped.length} member video(s) could not be summarized and are NOT included below.`]
                : []),
            "",
            ...covered.map((member) =>
                [
                    `### Video ${member.videoId} — "${member.title}" (${member.uploadDate ?? "unknown date"})`,
                    `TL;DR: ${member.summary.tldr}`,
                    `Key points: ${member.summary.keyPoints.join("; ")}`,
                    `Learnings: ${member.summary.learnings.join("; ")}`,
                    ...(member.summary.conclusion ? [`Verdict: ${member.summary.conclusion}`] : []),
                ].join("\n")
            ),
        ].join("\n\n");

        opts.onProgress?.({ percent: 60, message: "Calling LLM for report synthesis (structured output)" });
        const startedAt = new Date();
        const result = await this.deps.callLLMStructured({
            systemPrompt: REPORT_SYSTEM_BASE,
            userPrompt,
            providerChoice: opts.providerChoice,
            schema: ReportSchema,
        });
        const completedAt = new Date();
        const ids = identifyProviderChoice(opts.providerChoice);
        await recordYoutubeUsage({
            action: "report:synthesize",
            provider: ids.provider,
            model: ids.model,
            usage: result.usage,
            scope: opts.members.map((member) => member.videoId).join(","),
            videoId: opts.members.map((member) => member.videoId).join(","),
            prompt: formatPrompt(REPORT_SYSTEM_BASE, userPrompt),
            response: result.content,
            durationMs: completedAt.getTime() - startedAt.getTime(),
            startedAt: startedAt.toISOString(),
            completedAt: completedAt.toISOString(),
        });
        const synthesized = result.object as Omit<VideoReport, "perVideo"> & {
            perVideo: Array<{ videoId: string; capsule: string; standout: string }>;
        };

        // Index the LLM's per-video entries, folding duplicates (a video id the
        // model emitted twice keeps the first entry, not silently the last).
        const byLlm = new Map<string, { capsule: string; standout: string }>();
        const duplicateIds: string[] = [];

        for (const entry of synthesized.perVideo) {
            if (byLlm.has(entry.videoId)) {
                duplicateIds.push(entry.videoId);
                continue;
            }

            byLlm.set(entry.videoId, entry);
        }

        // Merge: covered members must have a synthesized capsule — a missing one
        // becomes an explicit skipped reason instead of a silent blank row.
        // Skipped members are appended with their own reason so a failed member
        // never fails the report.
        const missingIds: string[] = [];
        const perVideo: VideoReport["perVideo"] = opts.members.map((member) => {
            if (member.summary === null) {
                return { videoId: member.videoId, capsule: "", standout: "", skipped: member.skipped ?? "skipped" };
            }

            const fromLlm = byLlm.get(member.videoId);

            if (!fromLlm) {
                missingIds.push(member.videoId);

                return {
                    videoId: member.videoId,
                    capsule: "",
                    standout: "",
                    skipped: "synthesis did not cover this video",
                };
            }

            return { videoId: member.videoId, capsule: fromLlm.capsule, standout: fromLlm.standout, skipped: null };
        });

        if (duplicateIds.length > 0 || missingIds.length > 0) {
            logger.warn(
                { duplicateIds, missingIds, covered: covered.length },
                "youtube report synthesis: LLM per-video coverage mismatch"
            );
        }

        return { ...synthesized, perVideo };
    }
}

export interface PickSectionOpts {
    override?: number;
    length?: SummaryLength;
}

/**
 * Pick the number of timestamped sections for a given video duration.
 * Constraint: each section between 3 and 15 minutes. Length flag:
 * - short → ceil(totalSec / 900)  (each section ~15 min)
 * - auto  → target ~6 min/section, clamped to [minSections, maxSections]
 * - detailed → target ~3 min/section, capped at 30
 */
export function pickSectionCount(totalSec: number, opts: PickSectionOpts = {}): number {
    if (opts.override && opts.override > 0) {
        return opts.override;
    }

    if (totalSec <= 180) {
        return 1;
    }

    const minSections = Math.max(1, Math.ceil(totalSec / 900));
    const maxSections = Math.max(1, Math.floor(totalSec / 180));

    if (opts.length === "short") {
        return minSections;
    }

    if (opts.length === "detailed") {
        return Math.min(30, maxSections);
    }

    const ideal = Math.round(totalSec / 360);
    return Math.max(minSections, Math.min(maxSections, ideal));
}

function clampSections(sections: TimestampedSummaryEntry[], totalSec: number): TimestampedSummaryEntry[] {
    const cap = Math.max(0, Math.round(totalSec));
    return sections
        .map((section) => ({
            startSec: clampSec(section.startSec, cap),
            endSec: Math.max(clampSec(section.endSec, cap), clampSec(section.startSec, cap)),
            icon: section.icon?.trim() || "🎯",
            title: section.title?.trim() || section.text.split(/[.!?]/, 1)[0]?.slice(0, 60) || "Section",
            question: section.question?.trim(),
            text: section.text.trim(),
        }))
        .filter((section) => section.text.length > 0);
}

/**
 * Post-validates long-summary chapters the way `clampSections` does for
 * timestamped sections: clamp startSec/endSec into `[0, totalSec]`, and drop
 * any chapter whose clamped start would break ascending order (a hallucinated
 * out-of-order anchor must not corrupt the tick rendering). Chapters without a
 * numeric anchor (back-compat rows) pass through untouched.
 */
function clampChapters(chapters: VideoLongSummaryChapter[], totalSec: number): VideoLongSummaryChapter[] {
    const cap = Math.max(0, Math.round(totalSec));
    const out: VideoLongSummaryChapter[] = [];
    let lastStart = -1;

    for (const chapter of chapters) {
        if (typeof chapter.startSec !== "number") {
            out.push(chapter);
            continue;
        }

        const startSec = clampSec(chapter.startSec, cap);

        if (startSec < lastStart) {
            continue;
        }

        const endSec =
            chapter.endSec === null || chapter.endSec === undefined
                ? chapter.endSec
                : Math.max(clampSec(chapter.endSec, cap), startSec);
        out.push({ ...chapter, startSec, endSec });
        lastStart = startSec;
    }

    return out;
}

const PARTIAL_MIN_GAP_MS = 250;

function createSummaryPartialThrottle(onPartial?: (partial: unknown) => void): PartialThrottle<unknown> | null {
    if (!onPartial) {
        return null;
    }

    return createPartialThrottle<unknown>({ minGapMs: PARTIAL_MIN_GAP_MS, emit: onPartial });
}

function withTone(base: string, tone?: SummaryTone): string {
    if (!tone) {
        return base;
    }

    return `${base}\n\n${TONE_INSTRUCTIONS[tone]}`;
}

/** Whether a stored artifact's lang matches the requested lang (both default to `"en"`). */
function sameLang(stored: string, requested?: string): boolean {
    return (requested ?? "en") === (stored ?? "en");
}

/**
 * Whether a request carries no prompt-shaping beyond the persisted language.
 * The video summary columns store `lang` but NOT tone/length/format/preset, so
 * a shaped request must neither be served from that cache (it would get a
 * mismatched artifact) nor written into it (it would poison later default
 * requests). The documented defaults — tone "insightful", length "auto", format
 * "list", no preset — count as default; anything else is shaped.
 */
function isDefaultShaping(opts: SummarizeOpts): boolean {
    const defaultTone = !opts.tone || opts.tone === "insightful";
    const defaultLength = !opts.length || opts.length === "auto";
    const defaultFormat = !opts.format || opts.format === "list";

    return defaultTone && defaultLength && defaultFormat && !opts.presetInstructions;
}

function withLang(base: string, lang?: string): string {
    if (!lang || lang === "en") {
        return base;
    }

    const name = englishLanguageName(lang);

    return `${base}\n\nRespond in ${name}. Keep technical terms, product names, and quoted phrases in their original language. Use natural ${name} phrasing, not literal translation.`;
}

function withLength(base: string, length?: SummaryLength): string {
    if (!length || length === "auto") {
        return base;
    }

    if (length === "short") {
        return `${base}\n\nLength budget: short. Stay concise — fewer key points and learnings, brief chapters.`;
    }

    return `${base}\n\nLength budget: detailed. Be thorough — many key points, granular chapters, more learnings.`;
}

/**
 * Appends the user's preset instructions AFTER all other system prompt
 * construction (base + tone + length) — the injection point and framing are
 * security-relevant per 2026-07-15-RoadmapFeature11-PromptPersonas. Callers
 * pass already ownership-checked instructions; this must stay the LAST
 * thing appended to the system prompt.
 */
function withPreset(base: string, presetInstructions?: string): string {
    if (!presetInstructions) {
        return base;
    }

    return `${base}\n\n${buildPresetBlock(presetInstructions)}`;
}

function formatPrompt(systemPrompt: string, userPrompt: string): string {
    return `system:\n${systemPrompt}\n\nuser:\n${userPrompt}`;
}

function formatTranscriptWithTimestamps(transcript: Transcript): string {
    if (!transcript.segments.length) {
        return transcript.text;
    }

    return transcript.segments.map((segment) => `[${formatTime(segment.start)}] ${segment.text}`).join("\n");
}

function formatTime(seconds: number): string {
    const safe = Math.max(0, Math.floor(seconds));
    const m = Math.floor(safe / 60);
    const s = safe % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function clampSec(value: unknown, totalSec: number): number {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : NaN;

    if (!Number.isFinite(n) || n < 0) {
        return 0;
    }

    return Math.min(Math.round(n), Math.max(0, Math.round(totalSec)));
}

export function bucketSegments(transcript: Transcript, binSizeSec: number): SummaryBin[] {
    if (!transcript.segments.length) {
        return [{ startSec: 0, endSec: transcript.durationSec ?? 0, text: transcript.text }];
    }

    const bins: Array<{ startSec: number; endSec: number; texts: string[] } | undefined> = [];

    for (const segment of transcript.segments) {
        const binIndex = Math.floor(segment.start / binSizeSec);
        const slot = bins[binIndex] ?? {
            startSec: binIndex * binSizeSec,
            endSec: (binIndex + 1) * binSizeSec,
            texts: [],
        };
        slot.texts.push(segment.text);

        if (segment.end > slot.endSec) {
            slot.endSec = segment.end;
        }

        bins[binIndex] = slot;
    }

    return bins.flatMap((bin) => {
        if (!bin) {
            return [];
        }

        return [{ startSec: bin.startSec, endSec: bin.endSec, text: bin.texts.join(" ") }];
    });
}
