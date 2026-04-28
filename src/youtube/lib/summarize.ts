import logger from "@app/logger";
import { callLLM, callLLMStructured } from "@app/utils/ai/call-llm";
import { Summarizer } from "@app/utils/ai/tasks/Summarizer";
import type { YoutubeConfig } from "@app/youtube/lib/config";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import type { SummarizeOpts, SummarizeResult, SummaryBin, SummaryServiceDeps } from "@app/youtube/lib/summarize.types";
import type { Transcript } from "@app/youtube/lib/transcript.types";
import { compactTranscript } from "@app/youtube/lib/transcript-compact";
import { identifyProviderChoice, recordYoutubeUsage } from "@app/youtube/lib/usage";
import type {
    SummaryLength,
    SummaryTone,
    TimestampedSummaryEntry,
    VideoLongSummary,
} from "@app/youtube/lib/video.types";
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

const LongSchema = z.object({
    tldr: z.string().min(1).describe("2-3 sentences capturing the essence of the video."),
    keyPoints: z.array(z.string().min(1)).min(3).max(10).describe("3-10 bullet points."),
    learnings: z.array(z.string().min(1)).min(2).max(8).describe("2-8 takeaways."),
    chapters: z
        .array(z.object({ title: z.string().min(1).max(80), summary: z.string().min(1) }))
        .min(1)
        .max(12)
        .describe("Topical breakdown — not necessarily aligned with timestamps."),
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

        if (opts.mode === "short") {
            if (!opts.forceRecompute && video.summaryShort) {
                return { short: video.summaryShort };
            }

            const summary = await this.summarizeText(transcript.text, opts);
            this.db.setVideoSummary(opts.videoId, "short", summary);

            return { short: summary };
        }

        if (opts.mode === "long") {
            if (!opts.forceRecompute && video.summaryLong) {
                return { long: video.summaryLong };
            }

            const long = await this.summarizeLong(transcript, opts);
            this.db.setVideoSummary(opts.videoId, "long", long);

            return { long };
        }

        if (!opts.forceRecompute && video.summaryTimestamped) {
            return { timestamped: video.summaryTimestamped };
        }

        const timestamped = await this.summarizeTimestamped(transcript, opts);
        this.db.setVideoSummary(opts.videoId, "timestamped", timestamped);

        return { timestamped };
    }

    private async summarizeText(text: string, opts: SummarizeOpts): Promise<string> {
        opts.onProgress?.({ phase: "summarize", percent: 30, message: "Calling LLM for short summary" });
        const systemPrompt = withTone(SHORT_SUMMARY_SYSTEM_BASE, opts.tone);

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
                prompt: formatPrompt(systemPrompt, text),
                response: result.content,
                durationMs: completedAt.getTime() - startedAt.getTime(),
                startedAt: startedAt.toISOString(),
                completedAt: completedAt.toISOString(),
            });

            return result.content;
        }

        const provider = await this.config.get("provider");
        const providerName = opts.provider ?? provider.summarize ?? "default";
        const summarizer = await this.deps.createSummarizer({ provider: opts.provider ?? provider.summarize });

        try {
            const result = await summarizer.summarize(text);
            await recordYoutubeUsage({
                action: "summarize:short",
                provider: providerName,
                model: "(summarizer-default)",
                scope: opts.videoId,
            });

            return result.summary;
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
        const systemPrompt = withTone(baseSystem, opts.tone);
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
        const result = isQa
            ? await this.deps.callLLMStructured({
                  systemPrompt,
                  userPrompt,
                  providerChoice: opts.providerChoice,
                  schema: TimestampedQaSchema,
              })
            : await this.deps.callLLMStructured({
                  systemPrompt,
                  userPrompt,
                  providerChoice: opts.providerChoice,
                  schema: TimestampedListSchema,
              });
        opts.onProgress?.({ phase: "summarize", percent: 90, message: "Parsing timestamped sections" });
        const completedAt = new Date();
        const ids = identifyProviderChoice(opts.providerChoice);
        await recordYoutubeUsage({
            action: "summarize:timestamped",
            provider: ids.provider,
            model: ids.model,
            usage: result.usage,
            scope: opts.videoId,
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
        const systemPrompt = withTone(withLength(LONG_SUMMARY_SYSTEM_BASE, opts.length), opts.tone);
        const userPrompt = [
            `Write a rich long-form summary of this YouTube video.`,
            `Total duration: ${formatTime(totalSec)}.`,
            `Use only what is in the transcript. Be specific (numbers, products, names).`,
            ``,
            `Transcript:`,
            transcript.text,
        ].join("\n");

        opts.onProgress?.({
            phase: "summarize",
            percent: 30,
            message: "Calling LLM for long-form summary (structured output)",
        });
        const startedAt = new Date();
        const result = await this.deps.callLLMStructured({
            systemPrompt,
            userPrompt,
            providerChoice: opts.providerChoice,
            schema: LongSchema,
        });
        opts.onProgress?.({ phase: "summarize", percent: 90, message: "Parsing long-form structured response" });
        const completedAt = new Date();
        const ids = identifyProviderChoice(opts.providerChoice);
        await recordYoutubeUsage({
            action: "summarize:long",
            provider: ids.provider,
            model: ids.model,
            usage: result.usage,
            scope: opts.videoId,
            prompt: formatPrompt(systemPrompt, userPrompt),
            response: result.content,
            durationMs: completedAt.getTime() - startedAt.getTime(),
            startedAt: startedAt.toISOString(),
            completedAt: completedAt.toISOString(),
        });

        return result.object as VideoLongSummary;
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

function withTone(base: string, tone?: SummaryTone): string {
    if (!tone) {
        return base;
    }

    return `${base}\n\n${TONE_INSTRUCTIONS[tone]}`;
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

void logger; // imported for parity with other lib modules; not used directly here
