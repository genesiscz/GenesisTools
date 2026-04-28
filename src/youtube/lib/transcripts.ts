import { dirname, join } from "node:path";
import { Transcriber } from "@app/utils/ai/tasks/Transcriber";
import { withFileLock } from "@app/utils/storage";
import { audioPath, ensureBinaryDir } from "@app/youtube/lib/cache";
import { fetchCaptions } from "@app/youtube/lib/captions";
import type { YoutubeConfig } from "@app/youtube/lib/config";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import type { Transcript } from "@app/youtube/lib/transcript.types";
import type {
    TranscribeOpts,
    TranscriberProgressInfo,
    TranscriberResult,
    TranscriptServiceDeps,
} from "@app/youtube/lib/transcripts.types";
import { recordYoutubeUsage } from "@app/youtube/lib/usage";
import { downloadAudio } from "@app/youtube/lib/yt-dlp";

const DEFAULT_TRANSCRIPT_DEPS: TranscriptServiceDeps = {
    fetchCaptions,
    downloadAudio,
    createTranscriber: (opts) => Transcriber.create(opts),
};

export class TranscriptService {
    constructor(
        private readonly db: YoutubeDatabase,
        private readonly config: YoutubeConfig,
        private readonly deps: TranscriptServiceDeps = DEFAULT_TRANSCRIPT_DEPS
    ) {}

    async transcribe(opts: TranscribeOpts): Promise<Transcript> {
        const video = this.db.getVideo(opts.videoId);

        if (!video) {
            throw new Error(`unknown video: ${opts.videoId}`);
        }

        if (!opts.forceTranscribe) {
            const cached = this.db.getTranscript(opts.videoId, { preferLang: opts.lang ? [opts.lang] : undefined });

            if (cached) {
                return cached;
            }

            const preferredLangs = await this.preferredLangs(opts.lang);
            const captions = await this.deps.fetchCaptions({ videoId: opts.videoId, preferredLangs });

            if (captions) {
                this.db.saveTranscript({
                    videoId: opts.videoId,
                    lang: captions.lang,
                    source: "captions",
                    text: captions.text,
                    segments: captions.segments,
                });
                const saved = this.db.getTranscript(opts.videoId, { lang: captions.lang, source: "captions" });

                if (saved) {
                    return saved;
                }
            }
        }

        let audio = video.audioPath;

        if (!audio) {
            const nextAudio = audioPath({ cacheDir: this.cacheDir() }, video.channelHandle, video.id, "wav");
            ensureBinaryDir(nextAudio);
            await withFileLock(`${nextAudio}.lock`, async () => {
                opts.onProgress?.({ phase: "audio", message: "downloading audio" });
                const result = await this.deps.downloadAudio({
                    idOrUrl: opts.videoId,
                    outPath: nextAudio,
                    format: "wav",
                    sampleRate: 16000,
                    onProgress: (progress) =>
                        opts.onProgress?.({ phase: "audio", percent: progress.percent, message: progress.message }),
                    signal: opts.signal,
                });
                this.db.setVideoBinaryPath(video.id, "audio", result.path, result.sizeBytes);
            });
            audio = nextAudio;
        }

        const provider = await this.config.get("provider");
        const transcriber = await this.deps.createTranscriber({
            provider: opts.provider ?? provider.transcribe,
            persist: opts.persistProvider,
        });

        try {
            opts.onProgress?.({ phase: "transcribe", message: "running ASR" });
            const result = (await transcriber.transcribe(audio, {
                language: opts.lang,
                onProgress: (info: TranscriberProgressInfo) =>
                    opts.onProgress?.({ phase: "transcribe", percent: info.percent, message: info.message }),
            })) as TranscriberResult;
            await recordYoutubeUsage({
                action: "transcribe:ai",
                provider: opts.provider ?? provider.transcribe ?? "default",
                model: "(transcriber-default)",
                scope: opts.videoId,
            });
            const lang = result.language ?? opts.lang ?? "en";
            this.db.saveTranscript({
                videoId: opts.videoId,
                lang,
                source: "ai",
                text: result.text,
                segments:
                    result.segments?.map((segment) => ({
                        text: segment.text,
                        start: segment.start,
                        end: segment.end,
                    })) ?? [],
                durationSec: result.duration ?? null,
            });
            const saved = this.db.getTranscript(opts.videoId, { lang, source: "ai" });

            if (!saved) {
                throw new Error(`failed to save transcript: ${opts.videoId}`);
            }

            return saved;
        } finally {
            transcriber.dispose();
        }
    }

    private async preferredLangs(lang?: string): Promise<string[]> {
        const configured = await this.config.get("preferredLangs");

        if (!lang) {
            return configured;
        }

        return [lang, ...configured.filter((configuredLang) => configuredLang !== lang)];
    }

    private cacheDir(): string {
        return join(dirname(this.config.where()), "cache");
    }
}
