import { dirname, join } from "node:path";
import type { CallLLMOptions, CallLLMResult } from "@app/utils/ai/call-llm";
import { callLLM as defaultCallLLM } from "@app/utils/ai/call-llm";
import { Transcriber } from "@app/utils/ai/tasks/Transcriber";
import { speakerIndexFromLabel } from "@app/utils/ai/transcription/speaker-label";
import { withFileLock } from "@app/utils/storage";
import { estimateTokens } from "@app/utils/tokens";
import { audioPath, ensureBinaryDir } from "@app/youtube/lib/cache";
import { fetchCaptions } from "@app/youtube/lib/captions";
import type { YoutubeConfig } from "@app/youtube/lib/config";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import { englishLanguageName } from "@app/youtube/lib/languages";
import type { Transcript, TranscriptSegment } from "@app/youtube/lib/transcript.types";
import type {
    TranscribeOpts,
    TranscriberProgressInfo,
    TranscriberResult,
    TranscriptServiceDeps,
    TranslateTranscriptOpts,
} from "@app/youtube/lib/transcripts.types";
import { identifyProviderChoice, recordYoutubeUsage } from "@app/youtube/lib/usage";
import type { VideoId } from "@app/youtube/lib/video.types";
import { downloadAudio } from "@app/youtube/lib/yt-dlp";
import type { ProviderChoice } from "@ask/types";

/** Target input tokens per translation chunk — segments never split mid-line. */
const TRANSLATE_CHUNK_TARGET_TOKENS = 3000;

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
        const providerName = opts.provider ?? provider.transcribe;
        // Diarization is Deepgram-native only; other providers would trigger the
        // heavy local-pyannote fallback, so keep them exactly as before.
        const diarize = providerName?.includes("deepgram") ?? false;
        const transcriber = await this.deps.createTranscriber({
            provider: providerName,
            persist: opts.persistProvider,
        });

        try {
            opts.onProgress?.({ phase: "transcribe", message: "running ASR" });
            const result = (await transcriber.transcribe(audio, {
                language: opts.lang,
                diarize,
                onProgress: (info: TranscriberProgressInfo) =>
                    opts.onProgress?.({ phase: "transcribe", percent: info.percent, message: info.message }),
            })) as TranscriberResult;
            await recordYoutubeUsage({
                action: "transcribe:ai",
                provider: providerName ?? "default",
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
                    result.segments?.map((segment) => {
                        const speaker = speakerIndexFromLabel(segment.speaker);

                        return {
                            text: segment.text,
                            start: segment.start,
                            end: segment.end,
                            ...(speaker === undefined ? {} : { speaker }),
                        };
                    }) ?? [],
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

/**
 * Line-anchored transcript translation (Feature 08 Layer 2): chunks the
 * transcript on segment boundaries (~3k tokens/chunk), translates each chunk
 * with the timestamp preserved as a `[<sec>] <text>` prefix so segment
 * start/end times survive verbatim — the LLM never invents timing, it only
 * translates the text after each bracket. Stored as a sibling `transcripts`
 * row (same video, new lang, `source: "ai"`).
 */
export async function translateTranscript(opts: TranslateTranscriptOpts): Promise<Transcript> {
    const original = opts.db.getTranscript(opts.videoId);

    if (!original) {
        throw new Error(`no transcript for video ${opts.videoId}; transcribe first`);
    }

    const call = opts.callLLM ?? defaultCallLLM;
    const chunks = chunkSegmentsForTranslation(original.segments);
    const translatedSegments: TranscriptSegment[] = [];

    for (let i = 0; i < chunks.length; i++) {
        opts.onProgress?.({
            percent: Math.round((i / Math.max(1, chunks.length)) * 100),
            message: `Translating chunk ${i + 1}/${chunks.length}`,
        });
        const translated = await translateChunk({
            segments: chunks[i],
            lang: opts.lang,
            providerChoice: opts.providerChoice,
            videoId: opts.videoId,
            call,
        });
        translatedSegments.push(...translated);
    }

    opts.onProgress?.({ percent: 100, message: "Saving translated transcript" });
    opts.db.saveTranscript({
        videoId: opts.videoId,
        lang: opts.lang,
        source: "ai",
        text: translatedSegments.map((segment) => segment.text).join(" "),
        segments: translatedSegments,
        durationSec: original.durationSec,
    });
    const saved = opts.db.getTranscript(opts.videoId, { lang: opts.lang, source: "ai" });

    if (!saved) {
        throw new Error(`failed to save translated transcript: ${opts.videoId}`);
    }

    return saved;
}

/** Groups segments into chunks whose cumulative `[#<id>] <text>` line tokens stay under `targetTokens`. A segment is never split. */
export function chunkSegmentsForTranslation(
    segments: TranscriptSegment[],
    targetTokens: number = TRANSLATE_CHUNK_TARGET_TOKENS
): TranscriptSegment[][] {
    const chunks: TranscriptSegment[][] = [];
    let current: TranscriptSegment[] = [];
    let currentTokens = 0;

    for (const [index, segment] of segments.entries()) {
        const lineTokens = estimateTokens(formatTranslateLine(segment, index));

        if (current.length > 0 && currentTokens + lineTokens > targetTokens) {
            chunks.push(current);
            current = [];
            currentTokens = 0;
        }

        current.push(segment);
        currentTokens += lineTokens;
    }

    if (current.length > 0) {
        chunks.push(current);
    }

    return chunks;
}

async function translateChunk(opts: {
    segments: TranscriptSegment[];
    lang: string;
    providerChoice: ProviderChoice;
    videoId: VideoId;
    call: (opts: CallLLMOptions) => Promise<CallLLMResult>;
}): Promise<TranscriptSegment[]> {
    const name = englishLanguageName(opts.lang);
    const baseSystemPrompt = `Translate to ${name}. Return the same line structure "[#<id>] <text>", exactly one output line per input line, keeping each line's [#<id>] tag unchanged.`;
    const userPrompt = opts.segments.map(formatTranslateLine).join("\n");

    const attempt = async (extraInstruction?: string): Promise<Map<number, string> | null> => {
        const systemPrompt = extraInstruction ? `${baseSystemPrompt}\n\n${extraInstruction}` : baseSystemPrompt;
        const result = await opts.call({ systemPrompt, userPrompt, providerChoice: opts.providerChoice });
        const ids = identifyProviderChoice(opts.providerChoice);
        await recordYoutubeUsage({
            action: "transcript:translate",
            provider: ids.provider,
            model: ids.model,
            usage: result.usage,
            scope: opts.videoId,
            prompt: `system:\n${systemPrompt}\n\nuser:\n${userPrompt}`,
            response: result.content,
        });

        return parseTranslatedLines(result.content, opts.segments.length);
    };

    let translated = await attempt();

    if (!translated) {
        translated = await attempt(
            `You must return exactly ${opts.segments.length} lines, each starting with its original [#<id>] tag (ids 0-${opts.segments.length - 1}, each exactly once).`
        );
    }

    const byId = translated;
    if (!byId) {
        throw new Error(
            `translateTranscript: chunk translation did not preserve the [#id] line tags, expected ${opts.segments.length} lines`
        );
    }

    return opts.segments.map((segment, i) => ({ ...segment, text: byId.get(i) ?? segment.text }));
}

/** Monotonic index tag — rounded seconds are not unique for dense captions, ids are. */
function formatTranslateLine(segment: TranscriptSegment, index: number): string {
    return `[#${index}] ${segment.text}`;
}

/**
 * Maps "[#id] text" output lines back by id; `null` unless every id
 * `0..count-1` appears exactly once — a reordered/duplicated/dropped line
 * must trigger the retry, not silently attach text to the wrong timestamp.
 */
function parseTranslatedLines(content: string, count: number): Map<number, string> | null {
    const byId = new Map<number, string>();

    for (const raw of content.split("\n")) {
        const line = raw.trim();

        if (line.length === 0) {
            continue;
        }

        const match = /^\[#(\d+)\]\s*(.*)$/.exec(line);

        if (!match) {
            return null;
        }

        const id = Number(match[1]);

        if (id >= count || byId.has(id)) {
            return null;
        }

        byId.set(id, match[2]);
    }

    return byId.size === count ? byId : null;
}
