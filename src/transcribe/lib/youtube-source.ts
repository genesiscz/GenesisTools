import { getYoutube } from "@app/youtube/commands/_shared/ensure-pipeline";
import { dumpVideoMetadata } from "@app/youtube/lib/yt-dlp";
import type { TranscriptionResult } from "@genesiscz/utils/ai/types";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("transcribe");

export interface YoutubeTranscribeOpts {
    videoId: string;
    lang?: string;
    provider?: string;
    forceTranscribe?: boolean;
    onProgress?: (message: string) => void;
}

/**
 * Length from YouTube metadata. Does not download the audio, and writes nothing: `--price-only`
 * reads yt-dlp's metadata directly instead of `ensureMetadata`, which would store the channel and
 * the video in the YouTube database.
 */
export async function youtubeDurationSec(videoId: string): Promise<number> {
    const video = await dumpVideoMetadata(videoId);

    if (!video.durationSec || video.durationSec <= 0) {
        throw new Error(`YouTube video ${videoId} has no duration in its metadata.`);
    }

    return video.durationSec;
}

/**
 * YouTube driver. Captions first, then the existing audio transcription.
 * This is the same pipeline as `tools youtube transcribe`.
 */
export async function transcribeYoutubeSource(opts: YoutubeTranscribeOpts): Promise<TranscriptionResult> {
    log.info({ videoId: opts.videoId, forceTranscribe: opts.forceTranscribe === true }, "youtube driver");
    const yt = await getYoutube();
    await yt.videos.ensureMetadata(opts.videoId);
    const transcript = await yt.transcripts.transcribe({
        videoId: opts.videoId,
        forceTranscribe: opts.forceTranscribe,
        lang: opts.lang,
        provider: opts.provider,
        persistProvider: Boolean(opts.provider),
        onProgress: (info) => {
            opts.onProgress?.(info.message);
        },
    });

    return {
        text: transcript.text,
        language: transcript.lang,
        duration: transcript.durationSec ?? undefined,
        segments: transcript.segments.map((segment) => ({
            text: segment.text,
            start: segment.start,
            end: segment.end,
            speaker: segment.speaker === undefined ? undefined : String(segment.speaker),
        })),
    };
}
