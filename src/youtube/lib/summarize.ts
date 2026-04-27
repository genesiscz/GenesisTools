import { Summarizer } from "@app/utils/ai/tasks/Summarizer";
import type { YoutubeConfig } from "@app/youtube/lib/config";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import type { SummaryBin, SummaryServiceDeps, SummarizeOpts, SummarizeResult } from "@app/youtube/lib/summarize.types";
import type { Transcript } from "@app/youtube/lib/transcript.types";
import type { TimestampedSummaryEntry } from "@app/youtube/lib/video.types";

const DEFAULT_SUMMARY_DEPS: SummaryServiceDeps = {
    createSummarizer: (opts) => Summarizer.create(opts),
};

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
        const provider = await this.config.get("provider");
        const summarizer = await this.deps.createSummarizer({ provider: opts.provider ?? provider.summarize });

        try {
            opts.onProgress?.({ phase: "summarize", message: "summarizing transcript" });
            const result = await summarizer.summarize(text);

            return result.summary;
        } finally {
            summarizer.dispose();
        }
    }

    private async summarizeTimestamped(transcript: Transcript, opts: SummarizeOpts): Promise<TimestampedSummaryEntry[]> {
        const bins = bucketSegments(transcript, opts.binSizeSec ?? 120);
        const provider = await this.config.get("provider");
        const summarizer = await this.deps.createSummarizer({ provider: opts.provider ?? provider.summarize });

        try {
            const out: TimestampedSummaryEntry[] = [];

            for (let i = 0; i < bins.length; i++) {
                const bin = bins[i];
                opts.onProgress?.({ phase: "summarize", percent: i / bins.length, message: `Summarizing bin ${i + 1}/${bins.length}` });
                const result = await summarizer.summarize(bin.text);
                out.push({ startSec: bin.startSec, endSec: bin.endSec, text: result.summary });
            }

            return out;
        } finally {
            summarizer.dispose();
        }
    }
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
