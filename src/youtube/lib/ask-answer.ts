import { DEFAULT_MODEL_ID, MAX_LAZY_INDEX_PER_ASK } from "@app/youtube/lib/qa";
import type { AskCitation, AskHistoryTurn, QaSource } from "@app/youtube/lib/qa.types";
import { formatClock, videoUrl } from "@app/youtube/lib/transcript-export";
import type { VideoId } from "@app/youtube/lib/video.types";
import type { Youtube } from "@app/youtube/lib/youtube";
import type { ProviderChoice } from "@ask/types";
import { logger } from "@genesiscz/utils/logger";

export interface AnswerProgress {
    phase: "index" | "retrieve" | "answer";
    index?: number;
    total?: number;
    message: string;
}

export interface AnswerOverVideosOpts {
    yt: Youtube;
    videoIds: VideoId[];
    question: string;
    providerChoice: ProviderChoice;
    topK?: number;
    sources?: QaSource[];
    lang?: string;
    streaming?: boolean;
    streamTarget?: NodeJS.WritableStream;
    signal?: AbortSignal;
    onProgress?: (info: AnswerProgress) => void;
    /** Safety valve on a first ask over a large channel; null = index everything. */
    maxIndex?: number | null;
    /** Prior turns of an ask session, oldest first. Omitted for one-shot asks. */
    history?: AskHistoryTurn[];
    /** Extra system-prompt instructions from a saved preset (the `qa` pipeline stage passes these). */
    presetInstructions?: string;
}

export interface EnrichedCitation extends AskCitation {
    title: string;
    uploadDate: string | null;
    /** Deep link at the citation's start second. */
    url: string;
    startClock: string | null;
    endClock: string | null;
}

export interface AnswerOverVideosResult {
    answer: string;
    citations: EnrichedCitation[];
    /** Videos actually searched (had a transcript and an embedding index). */
    searchedVideoIds: VideoId[];
    /** Videos in scope with no transcript stored yet. */
    missingTranscript: VideoId[];
    /** Videos with a transcript that were left unindexed by `maxIndex`. */
    skippedUnindexed: VideoId[];
    indexedNow: number;
}

const DEFAULT_TOP_K = 12;
/** Same default `QaService.index()`/`ask()` apply when the caller pins no sources. */
const DEFAULT_SOURCES: QaSource[] = ["transcript"];

/**
 * The one answering path shared by the CLI, the ask sessions and the MCP
 * server: make sure every in-scope video is embedded, retrieve across all of
 * them at once, then hand back the answer with citations enriched into
 * "title @ mm:ss + deep link" form.
 */
export async function answerOverVideos(opts: AnswerOverVideosOpts): Promise<AnswerOverVideosResult> {
    const { yt } = opts;
    const withTranscript: VideoId[] = [];
    const missingTranscript: VideoId[] = [];

    for (const videoId of opts.videoIds) {
        if (yt.db.getTranscript(videoId)) {
            withTranscript.push(videoId);
            continue;
        }

        missingTranscript.push(videoId);
    }

    if (withTranscript.length === 0) {
        throw new Error(
            `ask: none of the ${opts.videoIds.length} video(s) in scope have a transcript yet — run "tools youtube queue add <target> --stages metadata,captions" first`
        );
    }

    // Check the exact buckets `qa.ask()` will read from: `hasQaChunks(videoId)` alone
    // is true for ANY source in ANY embedding model, so a video holding only comment
    // chunks (or chunks from another embedder) counted as indexed and was then searched
    // with no usable context. Mirrors the per-source check inside `QaService.index()`.
    const sources = opts.sources ?? DEFAULT_SOURCES;
    const needsIndex = withTranscript.filter((videoId) =>
        sources.some((source) => !yt.db.hasQaChunks(videoId, DEFAULT_MODEL_ID, source))
    );
    // Default to a BUDGET, not "everything". A channel scope can reach thousands
    // of stored transcripts, and defaulting to all of them made a single
    // `youtube ask --channel` sequentially embed the entire channel before it
    // answered: a very long blocking command and, on a paid embedder, a very
    // expensive one. `MAX_LAZY_INDEX_PER_ASK` is the cap `selectCandidateVideos`
    // has always applied to lazy indexing; this is the same rule, applied where
    // every caller (CLI, MCP, HTTP) inherits it. Pass `maxIndex: null` to opt
    // into indexing everything.
    const budget = opts.maxIndex === null ? needsIndex.length : (opts.maxIndex ?? MAX_LAZY_INDEX_PER_ASK);
    const toIndex = needsIndex.slice(0, budget);
    const skippedUnindexed = needsIndex.slice(budget);
    let indexedNow = 0;

    for (const [position, videoId] of toIndex.entries()) {
        opts.signal?.throwIfAborted();
        opts.onProgress?.({
            phase: "index",
            index: position + 1,
            total: toIndex.length,
            message: `indexing ${videoId}`,
        });
        const result = await yt.qa.index({ videoId, sources: opts.sources, signal: opts.signal });
        indexedNow += result.indexed;
    }

    const searchedVideoIds = withTranscript.filter((videoId) => !skippedUnindexed.includes(videoId));
    const videos = yt.db.getVideosByIds(searchedVideoIds);
    const metaById = new Map(videos.map((video) => [video.id, video]));
    const crossVideo =
        searchedVideoIds.length > 1
            ? {
                  videos: Object.fromEntries(
                      videos.map((video) => [video.id, { title: video.title, uploadDate: video.uploadDate }])
                  ),
                  skippedUnindexed: skippedUnindexed.length,
              }
            : undefined;

    opts.onProgress?.({
        phase: "answer",
        message: `asking ${opts.providerChoice.provider.name}/${opts.providerChoice.model.id} over ${searchedVideoIds.length} video(s)`,
    });
    const result = await yt.qa.ask({
        videoIds: searchedVideoIds,
        question: opts.question,
        topK: opts.topK ?? DEFAULT_TOP_K,
        providerChoice: opts.providerChoice,
        streaming: opts.streaming,
        streamTarget: opts.streamTarget,
        sources: opts.sources,
        lang: opts.lang,
        presetInstructions: opts.presetInstructions,
        crossVideo,
        history: opts.history,
    });
    logger.info(
        {
            videos: searchedVideoIds.length,
            citations: result.citations.length,
            missingTranscript: missingTranscript.length,
            skippedUnindexed: skippedUnindexed.length,
        },
        "youtube ask answered"
    );

    return {
        answer: result.answer,
        citations: result.citations.map((citation) => {
            const meta = metaById.get(citation.videoId);

            return {
                ...citation,
                title: meta?.title ?? citation.videoId,
                uploadDate: meta?.uploadDate ?? null,
                url: videoUrl(citation.videoId, citation.startSec),
                startClock: citation.startSec === null ? null : formatClock(citation.startSec),
                endClock: citation.endSec === null ? null : formatClock(citation.endSec),
            };
        }),
        searchedVideoIds,
        missingTranscript,
        skippedUnindexed,
        indexedNow,
    };
}

/** `[#1] Title (2026-04-24) 12:03-14:31 → https://…&t=723s` — one line per citation. */
export function formatCitationLines(citations: EnrichedCitation[]): string[] {
    return citations.map((citation, index) => {
        const when =
            citation.startClock === null
                ? citation.source
                : `${citation.startClock}${citation.endClock ? `-${citation.endClock}` : ""}`;
        const date = citation.uploadDate ? ` (${citation.uploadDate})` : "";

        return `[#${index + 1}] ${citation.title}${date}  ${when}  ${citation.url}`;
    });
}
