import { callLLM } from "@app/utils/ai/call-llm";
import { Embedder } from "@app/utils/ai/tasks/Embedder";
import type { VideoComment } from "@app/youtube/lib/comments.types";
import type { YoutubeConfig } from "@app/youtube/lib/config";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import type { TranscriptSearchHit } from "@app/youtube/lib/db.types";
import { buildPresetBlock } from "@app/youtube/lib/presets";
import type {
    AskOpts,
    AskResult,
    ChunkedTranscript,
    CommentChunk,
    IndexOpts,
    IndexResult,
    QaServiceDeps,
    TranscriptChunkSource,
} from "@app/youtube/lib/qa.types";
import { identifyProviderChoice, recordYoutubeUsage } from "@app/youtube/lib/usage";
import type { VideoId } from "@app/youtube/lib/video.types";

const TARGET_TOKENS_PER_CHUNK = 1500;
const TARGET_CHARS = TARGET_TOKENS_PER_CHUNK * 4;
const TOP_K_DEFAULT = 8;
const DEFAULT_MODEL_ID = "default";

const DEFAULT_QA_DEPS: QaServiceDeps = {
    createEmbedder: (opts) => Embedder.create(opts),
    callLLM,
};

export class QaService {
    constructor(
        private readonly db: YoutubeDatabase,
        private readonly config: YoutubeConfig,
        private readonly deps: QaServiceDeps = DEFAULT_QA_DEPS
    ) {}

    async index(opts: IndexOpts): Promise<IndexResult> {
        const transcript = this.db.getTranscript(opts.videoId);

        if (!transcript) {
            throw new Error(`no transcript to index for ${opts.videoId}`);
        }

        const provider = await this.config.get("provider");
        const modelId = opts.model ?? DEFAULT_MODEL_ID;
        const embedder = await this.deps.createEmbedder({
            provider: opts.provider ?? provider.embed,
            model: opts.model,
        });

        try {
            if (!opts.forceReindex && this.db.hasQaChunks(opts.videoId, modelId)) {
                return { indexed: 0, modelId };
            }

            opts.signal?.throwIfAborted();
            const chunks = chunkTranscript(transcript);
            const vectors = await embedder.embedBatch(chunks.map((chunk) => chunk.text));
            await recordYoutubeUsage({
                action: "qa:embed",
                provider: opts.provider ?? provider.embed ?? "default",
                model: modelId,
                scope: opts.videoId,
            });

            for (let i = 0; i < chunks.length; i++) {
                opts.signal?.throwIfAborted();
                const vector = vectors[i];

                if (!vector) {
                    throw new Error(`embedding missing for chunk ${i} of ${opts.videoId}`);
                }

                this.db.upsertQaChunk({
                    videoId: opts.videoId,
                    chunkIdx: i,
                    text: chunks[i].text,
                    startSec: chunks[i].startSec,
                    endSec: chunks[i].endSec,
                    embedding: vector.vector,
                    embedderModel: modelId,
                });
            }

            return { indexed: chunks.length, modelId };
        } finally {
            embedder.dispose();
        }
    }

    async ask(opts: AskOpts): Promise<AskResult> {
        if (!opts.videoIds.length) {
            throw new Error("ask: at least one videoId required");
        }

        const provider = await this.config.get("provider");
        const embedder = await this.deps.createEmbedder({ provider: provider.embed });

        try {
            const questionEmbedding = await embedder.embed(opts.question);
            const qVec = questionEmbedding.vector;
            const ranked = opts.videoIds
                .flatMap((videoId) => this.db.listQaChunks(videoId))
                .filter((chunk) => chunk.embedding && chunk.embedding.length === qVec.length)
                .map((chunk) => ({ chunk, score: cosine(qVec, chunk.embedding!) }))
                .sort((a, b) => b.score - a.score)
                .slice(0, opts.topK ?? TOP_K_DEFAULT);

            const context = ranked
                .map(
                    (rankedChunk, i) =>
                        `[#${i + 1} ${rankedChunk.chunk.videoId} @${formatTime(rankedChunk.chunk.startSec)}] ${rankedChunk.chunk.text}`
                )
                .join("\n\n");
            const baseSystemPrompt =
                "You answer questions about YouTube video transcripts. Cite the [#N] markers from the context to back every claim. If the context doesn't contain the answer, say so plainly.";
            // Preset instructions append LAST, after all system instructions —
            // security-relevant per 2026-07-15-RoadmapFeature11-PromptPersonas.
            const systemPrompt = opts.presetInstructions
                ? `${baseSystemPrompt}\n\n${buildPresetBlock(opts.presetInstructions)}`
                : baseSystemPrompt;
            const userPrompt = `Question: ${opts.question}\n\nContext from transcripts:\n${context}`;
            const startedAt = new Date();
            const result = await this.deps.callLLM({
                systemPrompt,
                userPrompt,
                providerChoice: opts.providerChoice,
                streaming: opts.streaming,
                streamTarget: opts.streamTarget,
            });
            const completedAt = new Date();
            const ids = identifyProviderChoice(opts.providerChoice);
            await recordYoutubeUsage({
                action: "qa:ask",
                provider: ids.provider,
                model: ids.model,
                usage: result.usage,
                scope: opts.videoIds.join(","),
                prompt: `system:\n${systemPrompt}\n\nuser:\n${userPrompt}`,
                response: result.content,
                durationMs: completedAt.getTime() - startedAt.getTime(),
                startedAt: startedAt.toISOString(),
                completedAt: completedAt.toISOString(),
            });

            return {
                answer: result.content,
                citations: ranked.map((rankedChunk) => ({
                    videoId: rankedChunk.chunk.videoId,
                    chunkIdx: rankedChunk.chunk.chunkIdx,
                    startSec: rankedChunk.chunk.startSec,
                    endSec: rankedChunk.chunk.endSec,
                    source: rankedChunk.chunk.source,
                    author: null,
                    commentId: rankedChunk.chunk.sourceRef,
                })),
            };
        } finally {
            embedder.dispose();
        }
    }

    keywordSearch(query: string, videoIds?: VideoId[], limit?: number): TranscriptSearchHit[] {
        return this.db.searchTranscripts(query, { videoIds, limit });
    }
}

export function chunkTranscript(transcript: TranscriptChunkSource): ChunkedTranscript[] {
    if (!transcript.segments.length) {
        const out: ChunkedTranscript[] = [];

        for (let i = 0; i < transcript.text.length; i += TARGET_CHARS) {
            out.push({ text: transcript.text.slice(i, i + TARGET_CHARS), startSec: null, endSec: null });
        }

        return out.length ? out : [{ text: "", startSec: null, endSec: transcript.durationSec ?? null }];
    }

    const out: ChunkedTranscript[] = [];
    let buffer: string[] = [];
    let bufferStart = transcript.segments[0]?.start ?? 0;
    let bufferEnd = bufferStart;
    let bufferChars = 0;

    for (const segment of transcript.segments) {
        const nextLength = bufferChars + segment.text.length + 1;

        if (nextLength > TARGET_CHARS && buffer.length) {
            out.push({ text: buffer.join(" "), startSec: bufferStart, endSec: bufferEnd });
            buffer = [];
            bufferStart = segment.start;
            bufferChars = 0;
        }

        buffer.push(segment.text);
        bufferEnd = segment.end;
        bufferChars += segment.text.length + 1;
    }

    if (buffer.length) {
        out.push({ text: buffer.join(" "), startSec: bufferStart, endSec: bufferEnd });
    }

    return out;
}

/**
 * Chunk comment threads for embedding. Threads keep root + replies together
 * (reply order = fetch order), every message is prefixed `@<author>: ` so
 * handles survive into the chunk text. Long threads split at reply boundaries;
 * tiny threads merge up to the target size (a merged chunk keeps the FIRST
 * thread's root id as its `rootCommentId`).
 */
export function chunkComments(comments: VideoComment[]): CommentChunk[] {
    const known = new Set(comments.map((comment) => comment.commentId));
    const repliesByParent = new Map<string, VideoComment[]>();
    const roots: VideoComment[] = [];

    for (const comment of comments) {
        if (comment.parentCommentId && known.has(comment.parentCommentId)) {
            const siblings = repliesByParent.get(comment.parentCommentId) ?? [];
            siblings.push(comment);
            repliesByParent.set(comment.parentCommentId, siblings);
            continue;
        }

        roots.push(comment);
    }

    // Per-thread pass: one chunk per thread, splitting oversize threads at
    // reply (message) boundaries — never mid-message.
    const perThread: CommentChunk[] = [];

    for (const root of roots) {
        const messages = [root, ...(repliesByParent.get(root.commentId) ?? [])].map(
            // yt-dlp authors usually already carry the "@" — normalize so the
            // prefix is always exactly one "@".
            (comment) => `@${(comment.author ?? "unknown").replace(/^@/, "")}: ${comment.text}`
        );
        let buffer: string[] = [];
        let bufferChars = 0;

        for (const message of messages) {
            if (bufferChars + message.length + 1 > TARGET_CHARS && buffer.length) {
                perThread.push({ text: buffer.join("\n"), rootCommentId: root.commentId });
                buffer = [];
                bufferChars = 0;
            }

            buffer.push(message);
            bufferChars += message.length + 1;
        }

        if (buffer.length) {
            perThread.push({ text: buffer.join("\n"), rootCommentId: root.commentId });
        }
    }

    // Merge pass: pack adjacent small thread-chunks up to the target so tiny
    // threads don't each burn an embedding.
    const out: CommentChunk[] = [];

    for (const chunk of perThread) {
        const last = out[out.length - 1];

        if (last && last.text.length + chunk.text.length + 2 <= TARGET_CHARS) {
            last.text = `${last.text}\n\n${chunk.text}`;
            continue;
        }

        out.push({ ...chunk });
    }

    return out;
}

export function cosine(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    return normA > 0 && normB > 0 ? dot / Math.sqrt(normA * normB) : 0;
}

function formatTime(value: number | null): string {
    if (value === null) {
        return "?";
    }

    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);

    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
