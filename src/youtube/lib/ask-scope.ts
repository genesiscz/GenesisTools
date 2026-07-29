import type { AskSessionScopeKind } from "@app/youtube/lib/db.types";
import { normaliseHandle } from "@app/youtube/lib/queue";
import { type ImportTranscriptDirResult, importTranscriptDir } from "@app/youtube/lib/transcript-export";
import type { VideoId } from "@app/youtube/lib/video.types";
import type { Youtube } from "@app/youtube/lib/youtube";
import { logger } from "@genesiscz/utils/logger";

export interface AskScopeInput {
    /** `@handle` — every video the DB knows for that channel. */
    channel?: string;
    /** Explicit video ids (already extracted from URLs by the caller). */
    videoIds?: string[];
    /** Directory of exported transcripts; imported into the DB, then asked over. */
    dir?: string;
    /** Cap on channel members, newest first. */
    limit?: number;
}

export interface ResolvedAskScope {
    kind: AskSessionScopeKind;
    /** Channel handle, directory path, or "" for an explicit id list. */
    value: string;
    videoIds: VideoId[];
    /** Present only for `kind: "dir"`. */
    imported?: ImportTranscriptDirResult;
}

/**
 * Turns one of the three corpus selectors into a concrete id list. A directory
 * is imported into the database first, so every downstream step (chunking,
 * embedding, retrieval, citation) runs the single shared code path — there is
 * no separate "files" retrieval engine to keep in sync.
 */
export async function resolveAskScope(yt: Youtube, input: AskScopeInput): Promise<ResolvedAskScope> {
    const selectors = [input.channel, input.videoIds?.length ? "ids" : undefined, input.dir].filter(Boolean);

    if (selectors.length === 0) {
        throw new Error("ask scope: pass a channel (@handle), one or more video ids, or --dir");
    }

    if (selectors.length > 1) {
        throw new Error("ask scope: channel, video ids and --dir are mutually exclusive");
    }

    if (input.dir) {
        const imported = await importTranscriptDir({ db: yt.db, dir: input.dir });

        return {
            kind: "dir",
            value: input.dir,
            videoIds: imported.imported.map((entry) => entry.videoId as VideoId),
            imported,
        };
    }

    if (input.channel) {
        // Canonicalise first: `yt.videos.list` matches on the stored `@handle`, and
        // the result is persisted as the session's `scopeValue` and re-resolved on
        // every later ask, so a bare `mkbhd` would keep resolving to zero videos.
        const handle = normaliseHandle(input.channel);
        const videos = yt.videos.list({
            channel: handle,
            includeShorts: true,
            includeLive: true,
            limit: input.limit ?? 5_000,
        });
        logger.info({ channel: handle, videos: videos.length }, "youtube ask scope: channel resolved");

        return { kind: "channel", value: handle, videoIds: videos.map((video) => video.id) };
    }

    return { kind: "videos", value: "", videoIds: [...new Set(input.videoIds ?? [])] as VideoId[] };
}
