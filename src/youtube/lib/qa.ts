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
    QaChunk,
    QaServiceDeps,
    TranscriptChunkSource,
} from "@app/youtube/lib/qa.types";
import { identifyProviderChoice, recordYoutubeUsage } from "@app/youtube/lib/usage";
import type { VideoId } from "@app/youtube/lib/video.types";

const TARGET_TOKENS_PER_CHUNK = 1500;
const TARGET_CHARS = TARGET_TOKENS_PER_CHUNK * 4;
const TOP_K_DEFAULT = 8;
const DEFAULT_MODEL_ID = "default";
/** Both-scope retrieval favors the transcript — it is the authority; comments add sentiment. */
const BOTH_SCOPE_TRANSCRIPT_BOOST = 1.15;
/**
 * Comment chunks live in a disjoint chunk_idx range: the shipped
 * UNIQUE(video_id, chunk_idx, embedder_model) key cannot be altered
 * additively, so the offset keeps them from colliding with transcript rows.
 */
const COMMENT_CHUNK_IDX_BASE = 100_000;
const COMMENT_ATTRIBUTION_PROMPT =
    "Claims sourced from comments must be attributed ('commenters point out…', 'one viewer disagrees…') — never present viewer opinions as statements made in the video.";

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
        const sources = opts.sources ?? ["transcript"];
        const provider = await this.config.get("provider");
        const modelId = opts.model ?? DEFAULT_MODEL_ID;
        const embedder = await this.deps.createEmbedder({
            provider: opts.provider ?? provider.embed,
            model: opts.model,
        });

        try {
            let indexed = 0;

            if (sources.includes("transcript")) {
                const transcript = this.db.getTranscript(opts.videoId);

                if (!transcript) {
                    throw new Error(`no transcript to index for ${opts.videoId}`);
                }

                if (opts.forceReindex || !this.db.hasQaChunks(opts.videoId, modelId, "transcript")) {
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
                            source: "transcript",
                        });
                    }

                    indexed += chunks.length;
                }
            }

            if (sources.includes("comments")) {
                const comments = this.db.getComments(opts.videoId);

                if (
                    comments.length > 0 &&
                    (opts.forceReindex || !this.db.hasQaChunks(opts.videoId, modelId, "comments"))
                ) {
                    opts.signal?.throwIfAborted();
                    const chunks = chunkComments(comments);
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
                            throw new Error(`embedding missing for comment chunk ${i} of ${opts.videoId}`);
                        }

                        this.db.upsertQaChunk({
                            videoId: opts.videoId,
                            chunkIdx: COMMENT_CHUNK_IDX_BASE + i,
                            text: chunks[i].text,
                            embedding: vector.vector,
                            embedderModel: modelId,
                            source: "comments",
                            sourceRef: chunks[i].rootCommentId,
                        });
                    }

                    indexed += chunks.length;
                }
            }

            return { indexed, modelId };
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
            const sources = opts.sources ?? ["transcript"];
            const bothScope = sources.includes("transcript") && sources.includes("comments");
            const topK = opts.topK ?? TOP_K_DEFAULT;
            const questionEmbedding = await embedder.embed(opts.question);
            const qVec = questionEmbedding.vector;
            const scored = opts.videoIds
                .flatMap((videoId) => this.db.listQaChunks(videoId))
                .filter((chunk) => sources.includes(chunk.source))
                .filter((chunk) => chunk.embedding && chunk.embedding.length === qVec.length)
                .map((chunk) => ({ chunk, score: cosine(qVec, chunk.embedding!) }));
            // Top-K per selected source, merged; in Both scope transcript hits
            // get a boost (the transcript is the authority, comments add
            // sentiment), then the merged pool is cut back to topK.
            const ranked = sources
                .flatMap((source) =>
                    scored
                        .filter((entry) => entry.chunk.source === source)
                        .sort((a, b) => b.score - a.score)
                        .slice(0, topK)
                )
                .map((entry) =>
                    bothScope && entry.chunk.source === "transcript"
                        ? { ...entry, score: entry.score * BOTH_SCOPE_TRANSCRIPT_BOOST }
                        : entry
                )
                .sort((a, b) => b.score - a.score)
                .slice(0, topK);

            const context = ranked
                .map((rankedChunk, i) => `[#${i + 1} ${chunkTag(rankedChunk.chunk)}] ${rankedChunk.chunk.text}`)
                .join("\n\n");
            const baseSystemPrompt = [
                "You answer questions about YouTube video transcripts. Cite the [#N] markers from the context to back every claim. If the context doesn't contain the answer, say so plainly.",
                ...(sources.includes("comments") ? [COMMENT_ATTRIBUTION_PROMPT] : []),
            ].join(" ");
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
                    author: rankedChunk.chunk.source === "comments" ? chunkAuthor(rankedChunk.chunk.text) : null,
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

/** Prompt tag per source: `[transcript t=123s]` vs `[comment @handle]` (plus the video id). */
function chunkTag(chunk: QaChunk): string {
    if (chunk.source === "comments") {
        return `${chunk.videoId} comment @${chunkAuthor(chunk.text) ?? "unknown"}`;
    }

    return chunk.startSec !== null
        ? `${chunk.videoId} transcript t=${Math.round(chunk.startSec)}s`
        : `${chunk.videoId} transcript`;
}

/** Thread author from the chunk text's `@handle: ` prefix (see `chunkComments`). */
function chunkAuthor(text: string): string | null {
    const match = text.match(/^@([^:\n]+):/);

    return match ? match[1] : null;
}

