import { callLLM } from "@app/utils/ai/call-llm";
import { Summarizer } from "@app/utils/ai/tasks/Summarizer";
import logger from "@app/logger";
import type { YoutubeConfig } from "@app/youtube/lib/config";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import type { SummaryBin, SummaryServiceDeps, SummarizeOpts, SummarizeResult } from "@app/youtube/lib/summarize.types";
import type { Transcript } from "@app/youtube/lib/transcript.types";
import { identifyProviderChoice, recordYoutubeUsage, type YoutubeUsageAction } from "@app/youtube/lib/usage";
import type { TimestampedSummaryEntry } from "@app/youtube/lib/video.types";

const DEFAULT_SUMMARY_DEPS: SummaryServiceDeps = {
    createSummarizer: (opts) => Summarizer.create(opts),
    callLLM,
};

const DEFAULT_TARGET_BINS = 12;
const TIMESTAMPED_SYSTEM_PROMPT = "You read YouTube transcripts and produce timestamped highlights. Always respond with a single JSON array. Never wrap the JSON in prose, code fences, or any other text.";
const SHORT_SUMMARY_SYSTEM_PROMPT = "You summarise YouTube transcripts concisely. Reply with a 3-6 sentence summary covering the main points. No markdown, no preamble, no headings.";

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

        const transcript = this.db.getTranscript(opts.videoId);

        if (!transcript) {
            throw new Error(`no transcript for video ${opts.videoId}; transcribe first`);
        }

        if (opts.mode === "short") {
            if (!opts.forceRecompute && video.summaryShort) {
                return { short: video.summaryShort };
            }

            const summary = await this.summarizeText(transcript.text, opts);
            this.db.setVideoSummary(opts.videoId, "short", summary);

            return { short: summary };
        }

        if (!opts.forceRecompute && video.summaryTimestamped) {
            return { timestamped: video.summaryTimestamped };
        }

        const timestamped = await this.summarizeTimestamped(transcript, opts);
        this.db.setVideoSummary(opts.videoId, "timestamped", timestamped);

        return { timestamped };
    }

    private async summarizeText(text: string, opts: SummarizeOpts): Promise<string> {
        opts.onProgress?.({ phase: "summarize", message: "summarizing transcript" });

        if (opts.providerChoice) {
            const startedAt = new Date();
            const result = await this.deps.callLLM({
                systemPrompt: SHORT_SUMMARY_SYSTEM_PROMPT,
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
                prompt: formatPrompt(SHORT_SUMMARY_SYSTEM_PROMPT, text),
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

    private async summarizeTimestamped(transcript: Transcript, opts: SummarizeOpts): Promise<TimestampedSummaryEntry[]> {
        const totalSec = transcript.durationSec ?? transcript.segments.at(-1)?.end ?? 0;
        const targetBins = opts.targetBins ?? DEFAULT_TARGET_BINS;
        const formattedTranscript = formatTranscriptWithTimestamps(transcript);
        const userPrompt = [
            `Build timestamped highlights of this YouTube video. Total duration: ${formatTime(totalSec)}.`,
            `Output a JSON array (and ONLY a JSON array — no prose, no code fences) with about ${targetBins} entries.`,
            `Each entry must be {"startSec": <integer>, "endSec": <integer>, "text": "<one short sentence>"}.`,
            `Cover the entire video evenly. Times must be within [0, ${Math.max(0, Math.round(totalSec))}] seconds.`,
            ``,
            `Transcript:`,
            formattedTranscript,
        ].join("\n");

        opts.onProgress?.({ phase: "summarize", message: "Summarizing entire transcript in one call" });

        const action: YoutubeUsageAction = "summarize:timestamped";

        if (opts.providerChoice) {
            const startedAt = new Date();
            const result = await this.deps.callLLM({
                systemPrompt: TIMESTAMPED_SYSTEM_PROMPT,
                userPrompt,
                providerChoice: opts.providerChoice,
                streaming: false,
            });
            const completedAt = new Date();
            const ids = identifyProviderChoice(opts.providerChoice);
            await recordYoutubeUsage({
                action,
                provider: ids.provider,
                model: ids.model,
                usage: result.usage,
                scope: opts.videoId,
                prompt: formatPrompt(TIMESTAMPED_SYSTEM_PROMPT, userPrompt),
                response: result.content,
                durationMs: completedAt.getTime() - startedAt.getTime(),
                startedAt: startedAt.toISOString(),
                completedAt: completedAt.toISOString(),
            });

            return parseTimestampedJson(result.content, totalSec, transcript.text);
        }

        const provider = await this.config.get("provider");
        const providerName = opts.provider ?? provider.summarize ?? "default";
        const summarizer = await this.deps.createSummarizer({ provider: opts.provider ?? provider.summarize });

        try {
            const result = await summarizer.summarize(`${TIMESTAMPED_SYSTEM_PROMPT}\n\n${userPrompt}`);
            await recordYoutubeUsage({ action, provider: providerName, model: "(summarizer-default)", scope: opts.videoId });

            return parseTimestampedJson(result.summary, totalSec, transcript.text);
        } finally {
            summarizer.dispose();
        }
    }
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

function parseTimestampedJson(raw: string, totalSec: number, fullText: string): TimestampedSummaryEntry[] {
    const candidate = extractJsonArray(raw);

    if (!candidate) {
        logger.warn({ rawPreview: raw.slice(0, 200) }, "youtube summarize timestamped: no JSON array in response, falling back to single bin");
        return [{ startSec: 0, endSec: totalSec, text: raw.trim() || fullText.slice(0, 500) }];
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(candidate);
    } catch (error) {
        logger.warn({ error: error instanceof Error ? error.message : String(error), candidatePreview: candidate.slice(0, 200) }, "youtube summarize timestamped: JSON parse failed, falling back to single bin");
        return [{ startSec: 0, endSec: totalSec, text: raw.trim() || fullText.slice(0, 500) }];
    }

    if (!Array.isArray(parsed)) {
        return [{ startSec: 0, endSec: totalSec, text: raw.trim() || fullText.slice(0, 500) }];
    }

    const out: TimestampedSummaryEntry[] = [];

    for (const entry of parsed) {
        if (!entry || typeof entry !== "object") {
            continue;
        }

        const record = entry as { startSec?: unknown; endSec?: unknown; text?: unknown };
        const startSec = clampSec(record.startSec, totalSec);
        const endSec = clampSec(record.endSec, totalSec);
        const text = typeof record.text === "string" ? record.text.trim() : "";

        if (!text) {
            continue;
        }

        out.push({ startSec, endSec: Math.max(endSec, startSec), text });
    }

    if (out.length === 0) {
        return [{ startSec: 0, endSec: totalSec, text: raw.trim() || fullText.slice(0, 500) }];
    }

    return out;
}

function extractJsonArray(raw: string): string | null {
    const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");

    if (start === -1 || end === -1 || end <= start) {
        return null;
    }

    return trimmed.slice(start, end + 1);
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
        const slot = bins[binIndex] ?? { startSec: binIndex * binSizeSec, endSec: (binIndex + 1) * binSizeSec, texts: [] };
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
