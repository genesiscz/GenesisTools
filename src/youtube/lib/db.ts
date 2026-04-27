import { homedir } from "node:os";
import { join } from "node:path";
import { BaseDatabase } from "@app/utils/database";
import { withFileLock } from "@app/utils/storage";
import { deleteIfExists } from "@app/youtube/lib/cache";
import type { Channel, ChannelHandle } from "@app/youtube/lib/channel.types";
import type {
    ClaimJobOpts,
    EnqueueJobInput,
    GetTranscriptOpts,
    ListJobsOpts,
    ListVideosOpts,
    PruneExpiredBinariesOpts,
    PruneExpiredBinariesResult,
    SaveTranscriptInput,
    SearchTranscriptsOpts,
    SetVideoBinaryPathInput,
    SetVideoSummaryInput,
    TranscriptSearchHit,
    UpdateJobPartial,
    UpsertChannelInput,
    UpsertQaChunkInput,
    UpsertVideoInput,
} from "@app/youtube/lib/db.types";
import type { JobStage, JobStatus, JobTargetKind, PipelineJob } from "@app/youtube/lib/jobs.types";
import type { QaChunk } from "@app/youtube/lib/qa.types";
import type { Language, Transcript, TranscriptSegment } from "@app/youtube/lib/transcript.types";
import type { TimestampedSummaryEntry, Video, VideoId } from "@app/youtube/lib/video.types";

export const DEFAULT_DB_PATH = join(homedir(), ".genesis-tools", "youtube", "youtube.db");

const SCHEMA_VERSION = 1;

export class YoutubeDatabase extends BaseDatabase {
    constructor(dbPath: string = DEFAULT_DB_PATH) {
        super(dbPath);
    }

    protected initSchema(): void {
        this.db.exec(`
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS channels (
                handle TEXT PRIMARY KEY,
                channel_id TEXT,
                title TEXT,
                description TEXT,
                subscriber_count INTEGER,
                thumb_url TEXT,
                last_synced_at TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS videos (
                id TEXT PRIMARY KEY,
                channel_handle TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                upload_date TEXT,
                duration_sec INTEGER,
                view_count INTEGER,
                like_count INTEGER,
                language TEXT,
                available_caption_langs TEXT,
                tags_json TEXT,
                is_short INTEGER NOT NULL DEFAULT 0,
                is_live INTEGER NOT NULL DEFAULT 0,
                thumb_url TEXT,
                summary_short TEXT,
                summary_timestamped_json TEXT,
                audio_path TEXT,
                audio_size_bytes INTEGER,
                audio_cached_at TEXT,
                video_path TEXT,
                video_size_bytes INTEGER,
                video_cached_at TEXT,
                thumb_path TEXT,
                thumb_cached_at TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (channel_handle) REFERENCES channels(handle) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_videos_channel ON videos(channel_handle, upload_date DESC);
            CREATE INDEX IF NOT EXISTS idx_videos_upload ON videos(upload_date DESC);
            CREATE INDEX IF NOT EXISTS idx_videos_audio_age ON videos(audio_cached_at) WHERE audio_path IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_videos_video_age ON videos(video_cached_at) WHERE video_path IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_videos_thumb_age ON videos(thumb_cached_at) WHERE thumb_path IS NOT NULL;

            CREATE TABLE IF NOT EXISTS transcripts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                video_id TEXT NOT NULL,
                lang TEXT NOT NULL,
                source TEXT NOT NULL,
                text TEXT NOT NULL,
                segments_json TEXT,
                duration_sec REAL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
                UNIQUE (video_id, lang, source)
            );
            CREATE INDEX IF NOT EXISTS idx_transcripts_video ON transcripts(video_id);

            CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(
                text,
                video_id UNINDEXED,
                lang UNINDEXED,
                content='transcripts',
                content_rowid='id'
            );
            CREATE TRIGGER IF NOT EXISTS transcripts_ai
                AFTER INSERT ON transcripts BEGIN
                INSERT INTO transcripts_fts(rowid, text, video_id, lang)
                VALUES (new.id, new.text, new.video_id, new.lang);
            END;
            CREATE TRIGGER IF NOT EXISTS transcripts_ad
                AFTER DELETE ON transcripts BEGIN
                INSERT INTO transcripts_fts(transcripts_fts, rowid, text, video_id, lang)
                VALUES('delete', old.id, old.text, old.video_id, old.lang);
            END;
            CREATE TRIGGER IF NOT EXISTS transcripts_au
                AFTER UPDATE ON transcripts BEGIN
                INSERT INTO transcripts_fts(transcripts_fts, rowid, text, video_id, lang)
                VALUES('delete', old.id, old.text, old.video_id, old.lang);
                INSERT INTO transcripts_fts(rowid, text, video_id, lang)
                VALUES (new.id, new.text, new.video_id, new.lang);
            END;

            CREATE TABLE IF NOT EXISTS jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                target_kind TEXT NOT NULL,
                target TEXT NOT NULL,
                stages TEXT NOT NULL,
                current_stage TEXT,
                status TEXT NOT NULL,
                error TEXT,
                progress REAL NOT NULL DEFAULT 0,
                progress_message TEXT,
                parent_job_id INTEGER,
                worker_id TEXT,
                claimed_at TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                completed_at TEXT,
                FOREIGN KEY (parent_job_id) REFERENCES jobs(id) ON DELETE SET NULL
            );
            CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, current_stage);
            CREATE INDEX IF NOT EXISTS idx_jobs_target ON jobs(target_kind, target);
            CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs(parent_job_id);

            CREATE TABLE IF NOT EXISTS qa_chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                video_id TEXT NOT NULL,
                chunk_idx INTEGER NOT NULL,
                text TEXT NOT NULL,
                start_sec REAL,
                end_sec REAL,
                embedding BLOB,
                embedding_dims INTEGER,
                embedder_model TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
                UNIQUE (video_id, chunk_idx, embedder_model)
            );
            CREATE INDEX IF NOT EXISTS idx_qa_chunks_video ON qa_chunks(video_id);
        `);

        const existing = this.db
            .query<{ version: number }, [number]>("SELECT version FROM schema_version WHERE version = ?")
            .get(SCHEMA_VERSION);

        if (!existing) {
            this.db.run("INSERT INTO schema_version (version) VALUES (?)", [SCHEMA_VERSION]);
        }
    }

    upsertChannel(input: UpsertChannelInput): void {
        this.db.run(
            `INSERT INTO channels (handle, channel_id, title, description, subscriber_count, thumb_url, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(handle) DO UPDATE SET
                channel_id = COALESCE(excluded.channel_id, channels.channel_id),
                title = COALESCE(excluded.title, channels.title),
                description = COALESCE(excluded.description, channels.description),
                subscriber_count = COALESCE(excluded.subscriber_count, channels.subscriber_count),
                thumb_url = COALESCE(excluded.thumb_url, channels.thumb_url),
                updated_at = datetime('now')`,
            [
                input.handle,
                input.channelId ?? null,
                input.title ?? null,
                input.description ?? null,
                input.subscriberCount ?? null,
                input.thumbUrl ?? null,
            ]
        );
    }

    getChannel(handle: ChannelHandle): Channel | null {
        const row = this.db.query<ChannelRow, [string]>("SELECT * FROM channels WHERE handle = ?").get(handle);

        if (!row) {
            return null;
        }

        return rowToChannel(row);
    }

    listChannels(): Channel[] {
        const rows = this.db.query<ChannelRow, []>("SELECT * FROM channels ORDER BY handle").all();

        return rows.map(rowToChannel);
    }

    removeChannel(handle: ChannelHandle): void {
        this.db.run("DELETE FROM channels WHERE handle = ?", [handle]);
    }

    setChannelSynced(handle: ChannelHandle): void {
        this.db.run("UPDATE channels SET last_synced_at = datetime('now'), updated_at = datetime('now') WHERE handle = ?", [handle]);
    }

    upsertVideo(input: UpsertVideoInput): void {
        this.db.run(
            `INSERT INTO videos (id, channel_handle, title, description, upload_date, duration_sec, view_count, like_count, language, available_caption_langs, tags_json, is_short, is_live, thumb_url, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(id) DO UPDATE SET
                channel_handle = excluded.channel_handle,
                title = excluded.title,
                description = COALESCE(excluded.description, videos.description),
                upload_date = COALESCE(excluded.upload_date, videos.upload_date),
                duration_sec = COALESCE(excluded.duration_sec, videos.duration_sec),
                view_count = COALESCE(excluded.view_count, videos.view_count),
                like_count = COALESCE(excluded.like_count, videos.like_count),
                language = COALESCE(excluded.language, videos.language),
                available_caption_langs = COALESCE(excluded.available_caption_langs, videos.available_caption_langs),
                tags_json = COALESCE(excluded.tags_json, videos.tags_json),
                is_short = excluded.is_short,
                is_live = excluded.is_live,
                thumb_url = COALESCE(excluded.thumb_url, videos.thumb_url),
                updated_at = datetime('now')`,
            [
                input.id,
                input.channelHandle,
                input.title,
                input.description ?? null,
                input.uploadDate ?? null,
                input.durationSec ?? null,
                input.viewCount ?? null,
                input.likeCount ?? null,
                input.language ?? null,
                input.availableCaptionLangs ? JSON.stringify(input.availableCaptionLangs) : null,
                input.tags ? JSON.stringify(input.tags) : null,
                input.isShort ? 1 : 0,
                input.isLive ? 1 : 0,
                input.thumbUrl ?? null,
            ]
        );
    }

    getVideo(id: VideoId): Video | null {
        const row = this.db.query<VideoRow, [string]>("SELECT * FROM videos WHERE id = ?").get(id);

        if (!row) {
            return null;
        }

        return rowToVideo(row);
    }

    listVideos(opts: ListVideosOpts = {}): Video[] {
        const where: string[] = [];
        const params: Array<string | number> = [];

        if (opts.channel) {
            where.push("channel_handle = ?");
            params.push(opts.channel);
        }

        if (opts.since) {
            where.push("upload_date >= ?");
            params.push(opts.since);
        }

        if (!opts.includeShorts) {
            where.push("is_short = 0");
        }

        if (!opts.includeLive) {
            where.push("is_live = 0");
        }

        const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const limit = opts.limit ?? 30;
        const offset = opts.offset ?? 0;
        const rows = this.db
            .query<VideoRow, [...Array<string | number>, number, number]>(`SELECT * FROM videos ${whereClause} ORDER BY upload_date DESC LIMIT ? OFFSET ?`)
            .all(...params, limit, offset);

        return rows.map(rowToVideo);
    }

    setVideoBinaryPath(input: SetVideoBinaryPathInput): void;
    setVideoBinaryPath(id: VideoId, kind: "audio" | "video" | "thumb", path: string | null, sizeBytes?: number): void;
    setVideoBinaryPath(inputOrId: SetVideoBinaryPathInput | VideoId, kind?: "audio" | "video" | "thumb", path?: string | null, sizeBytes?: number): void {
        const input = typeof inputOrId === "string" ? normalizeVideoBinaryPathInput(inputOrId, kind, path, sizeBytes) : inputOrId;
        const columns = videoBinaryColumns(input.kind);
        const cachedAt = input.path ? "datetime('now')" : "NULL";

        if (columns.sizeColumn) {
            this.db.run(
                `UPDATE videos SET ${columns.pathColumn} = ?, ${columns.sizeColumn} = ?, ${columns.cachedAtColumn} = ${cachedAt}, updated_at = datetime('now') WHERE id = ?`,
                [input.path, input.path ? input.sizeBytes ?? null : null, input.id]
            );
        } else {
            this.db.run(`UPDATE videos SET ${columns.pathColumn} = ?, ${columns.cachedAtColumn} = ${cachedAt}, updated_at = datetime('now') WHERE id = ?`, [input.path, input.id]);
        }
    }

    setVideoSummary(input: SetVideoSummaryInput): void;
    setVideoSummary(id: VideoId, kind: "short" | "timestamped", value: string | TimestampedSummaryEntry[]): void;
    setVideoSummary(inputOrId: SetVideoSummaryInput | VideoId, kind?: "short" | "timestamped", value?: string | TimestampedSummaryEntry[]): void {
        const input = typeof inputOrId === "string" ? normalizeVideoSummaryInput(inputOrId, kind, value) : inputOrId;
        const column = input.kind === "short" ? "summary_short" : "summary_timestamped_json";
        const serialized = typeof input.value === "string" ? input.value : JSON.stringify(input.value);

        this.db.run(`UPDATE videos SET ${column} = ?, updated_at = datetime('now') WHERE id = ?`, [serialized, input.id]);
    }

    saveTranscript(input: SaveTranscriptInput): void {
        this.db.run(
            `INSERT INTO transcripts (video_id, lang, source, text, segments_json, duration_sec)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(video_id, lang, source) DO UPDATE SET
                text = excluded.text,
                segments_json = excluded.segments_json,
                duration_sec = excluded.duration_sec,
                created_at = datetime('now')`,
            [input.videoId, input.lang, input.source, input.text, JSON.stringify(input.segments), input.durationSec ?? null]
        );
    }

    getTranscript(videoId: VideoId, opts: GetTranscriptOpts = {}): Transcript | null {
        if (opts.preferLang?.length) {
            for (const lang of opts.preferLang) {
                const transcript = this.getTranscript(videoId, { lang });

                if (transcript) {
                    return transcript;
                }
            }

            return null;
        }

        const where: string[] = ["video_id = ?"];
        const params: string[] = [videoId];

        if (opts.lang) {
            where.push("lang = ?");
            params.push(opts.lang);
        }

        if (opts.source) {
            where.push("source = ?");
            params.push(opts.source);
        }

        const row = this.db
            .query<TranscriptRow, string[]>(
                `SELECT * FROM transcripts WHERE ${where.join(" AND ")}
                 ORDER BY (source = 'captions') DESC, created_at DESC LIMIT 1`
            )
            .get(...params);

        if (!row) {
            return null;
        }

        return rowToTranscript(row);
    }

    listTranscripts(videoId: VideoId): Transcript[] {
        const rows = this.db.query<TranscriptRow, [string]>("SELECT * FROM transcripts WHERE video_id = ? ORDER BY lang, source").all(videoId);

        return rows.map(rowToTranscript);
    }

    searchTranscripts(query: string, opts: SearchTranscriptsOpts = {}): TranscriptSearchHit[] {
        const limit = opts.limit ?? 50;
        const snippetChars = opts.snippetChars ?? 50;
        const filterClause = opts.videoIds?.length ? `AND video_id IN (${opts.videoIds.map(() => "?").join(",")})` : "";
        const rows = this.db
            .query<TranscriptSearchRow, Array<string | number>>(
                `SELECT video_id, lang, snippet(transcripts_fts, 0, '<b>', '</b>', '…', ?) AS snippet, rank
                 FROM transcripts_fts WHERE transcripts_fts MATCH ? ${filterClause}
                 ORDER BY rank LIMIT ?`
            )
            .all(snippetChars, query, ...(opts.videoIds ?? []), limit);

        return rows.map((row) => ({
            videoId: row.video_id,
            lang: row.lang,
            snippet: row.snippet,
            rank: row.rank,
        }));
    }

    upsertQaChunk(input: UpsertQaChunkInput): void {
        const embedding = input.embedding ? Buffer.from(input.embedding.buffer, input.embedding.byteOffset, input.embedding.byteLength) : null;
        const embeddingDims = input.embedding ? input.embedding.length : null;

        this.db.run(
            `INSERT INTO qa_chunks (video_id, chunk_idx, text, start_sec, end_sec, embedding, embedding_dims, embedder_model)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(video_id, chunk_idx, embedder_model) DO UPDATE SET
                text = excluded.text,
                start_sec = excluded.start_sec,
                end_sec = excluded.end_sec,
                embedding = excluded.embedding,
                embedding_dims = excluded.embedding_dims`,
            [
                input.videoId,
                input.chunkIdx,
                input.text,
                input.startSec ?? null,
                input.endSec ?? null,
                embedding,
                embeddingDims,
                input.embedderModel ?? null,
            ]
        );
    }

    listQaChunks(videoId: VideoId, embedderModel?: string): QaChunk[] {
        const rows = embedderModel
            ? this.db.query<QaChunkRow, [string, string]>("SELECT * FROM qa_chunks WHERE video_id = ? AND embedder_model = ? ORDER BY chunk_idx").all(videoId, embedderModel)
            : this.db.query<QaChunkRow, [string]>("SELECT * FROM qa_chunks WHERE video_id = ? ORDER BY chunk_idx").all(videoId);

        return rows.map(rowToQaChunk);
    }

    hasQaChunks(videoId: VideoId, embedderModel?: string): boolean {
        const row = embedderModel
            ? this.db.query<{ count: number }, [string, string]>("SELECT COUNT(*) AS count FROM qa_chunks WHERE video_id = ? AND embedder_model = ?").get(videoId, embedderModel)
            : this.db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM qa_chunks WHERE video_id = ?").get(videoId);

        return (row?.count ?? 0) > 0;
    }

    enqueueJob(input: EnqueueJobInput): PipelineJob {
        const result = this.db
            .query<{ id: number }, [string, string, string, number | null]>(
                `INSERT INTO jobs (target_kind, target, stages, parent_job_id, status)
                 VALUES (?, ?, ?, ?, 'pending') RETURNING id`
            )
            .get(input.targetKind, input.target, JSON.stringify(input.stages), input.parentJobId ?? null);

        if (!result) {
            throw new Error("enqueueJob failed: insert returned no id");
        }

        const job = this.getJob(result.id);

        if (!job) {
            throw new Error(`enqueueJob: inserted id=${result.id} but read returned null`);
        }

        return job;
    }

    claimNextJob(workerId: string, opts: ClaimJobOpts = {}): PipelineJob | null {
        const stageClause = opts.stage ? "AND EXISTS (SELECT 1 FROM json_each(jobs.stages) WHERE value = ?)" : "";
        const row = opts.stage
            ? this.db
                  .query<JobRow, [string, string]>(
                      `UPDATE jobs SET status = 'running', worker_id = ?, claimed_at = datetime('now'), updated_at = datetime('now')
                       WHERE id = (
                           SELECT id FROM jobs WHERE status = 'pending' ${stageClause} ORDER BY id ASC LIMIT 1
                       )
                       RETURNING *`
                  )
                  .get(workerId, opts.stage)
            : this.db
                  .query<JobRow, [string]>(
                      `UPDATE jobs SET status = 'running', worker_id = ?, claimed_at = datetime('now'), updated_at = datetime('now')
                       WHERE id = (
                           SELECT id FROM jobs WHERE status = 'pending' ORDER BY id ASC LIMIT 1
                       )
                       RETURNING *`
                  )
                  .get(workerId);

        return row ? rowToJob(row) : null;
    }

    updateJob(id: number, partial: UpdateJobPartial): void {
        const existing = this.getJob(id);

        if (!existing) {
            throw new Error(`updateJob: job ${id} not found`);
        }

        if (partial.status !== undefined) {
            assertJobTransition(existing.status, partial.status, "updateJob");
        }

        const sets: string[] = [];
        const params: Array<string | number | null> = [];

        if (partial.status !== undefined) {
            sets.push("status = ?");
            params.push(partial.status);

            if (isTerminalJobStatus(partial.status) && partial.completedAt === undefined) {
                sets.push("completed_at = datetime('now')");
            }
        }

        if (partial.currentStage !== undefined) {
            sets.push("current_stage = ?");
            params.push(partial.currentStage);
        }

        if (partial.error !== undefined) {
            sets.push("error = ?");
            params.push(partial.error);
        }

        if (partial.progress !== undefined) {
            sets.push("progress = ?");
            params.push(partial.progress);
        }

        if (partial.progressMessage !== undefined) {
            sets.push("progress_message = ?");
            params.push(partial.progressMessage);
        }

        if (partial.completedAt !== undefined) {
            sets.push("completed_at = ?");
            params.push(partial.completedAt);
        }

        if (sets.length === 0) {
            return;
        }

        sets.push("updated_at = datetime('now')");
        params.push(id);
        this.db.run(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, params);
    }

    listJobs(opts: ListJobsOpts = {}): PipelineJob[] {
        const where: string[] = [];
        const params: Array<string | number> = [];

        if (opts.status) {
            where.push("status = ?");
            params.push(opts.status);
        }

        if (opts.targetKind) {
            where.push("target_kind = ?");
            params.push(opts.targetKind);
        }

        if (opts.target) {
            where.push("target = ?");
            params.push(opts.target);
        }

        if (opts.parentJobId !== undefined) {
            where.push("parent_job_id = ?");
            params.push(opts.parentJobId);
        }

        const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const limit = opts.limit ?? 100;
        const offset = opts.offset ?? 0;
        const rows = this.db.query<JobRow, [...Array<string | number>, number, number]>(`SELECT * FROM jobs ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);

        return rows.map(rowToJob);
    }

    markInterruptedJobsForRequeue(): number {
        const result = this.db.run(
            `UPDATE jobs SET status = 'pending', worker_id = NULL, claimed_at = NULL, current_stage = NULL,
                             progress = 0, progress_message = NULL, updated_at = datetime('now')
             WHERE status = 'running'`
        );

        return result.changes;
    }

    getJob(id: number): PipelineJob | null {
        const row = this.db.query<JobRow, [number]>("SELECT * FROM jobs WHERE id = ?").get(id);

        return row ? rowToJob(row) : null;
    }

    cancelJob(id: number): void {
        const existing = this.getJob(id);

        if (!existing) {
            return;
        }

        assertJobTransition(existing.status, "cancelled", "cancelJob");
        this.db.run("UPDATE jobs SET status = 'cancelled', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [id]);
    }

    async pruneExpiredBinaries(opts: PruneExpiredBinariesOpts): Promise<PruneExpiredBinariesResult> {
        return {
            audio: await this.pruneExpiredBinaryKind("audio", opts.audioOlderThanDays),
            video: await this.pruneExpiredBinaryKind("video", opts.videoOlderThanDays),
            thumb: await this.pruneExpiredBinaryKind("thumb", opts.thumbOlderThanDays),
        };
    }

    private async pruneExpiredBinaryKind(kind: "audio" | "video" | "thumb", olderThanDays?: number): Promise<number> {
        if (olderThanDays === undefined) {
            return 0;
        }

        const columns = videoBinaryColumns(kind);
        const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
        const rows = this.db
            .query<PruneBinaryRow, [string]>(
                `SELECT id, ${columns.pathColumn} AS path
                 FROM videos
                 WHERE ${columns.pathColumn} IS NOT NULL AND ${columns.cachedAtColumn} < ?
                 ORDER BY ${columns.cachedAtColumn} ASC`
            )
            .all(cutoff);
        let count = 0;

        for (const row of rows) {
            const filePath = row.path;

            if (!filePath) {
                continue;
            }

            await withFileLock(`${filePath}.lock`, async () => {
                await deleteIfExists(filePath);
                this.clearVideoBinaryPath(row.id, kind);
                count++;
            });
        }

        return count;
    }

    private clearVideoBinaryPath(id: VideoId, kind: "audio" | "video" | "thumb"): void {
        const columns = videoBinaryColumns(kind);

        if (columns.sizeColumn) {
            this.db.run(
                `UPDATE videos SET ${columns.pathColumn} = NULL, ${columns.sizeColumn} = NULL, ${columns.cachedAtColumn} = NULL, updated_at = datetime('now') WHERE id = ?`,
                [id]
            );
        } else {
            this.db.run(`UPDATE videos SET ${columns.pathColumn} = NULL, ${columns.cachedAtColumn} = NULL, updated_at = datetime('now') WHERE id = ?`, [id]);
        }
    }

    initSchemaForTest(): void {
        this.initSchema();
    }
}

interface VideoRow {
    id: VideoId;
    channel_handle: ChannelHandle;
    title: string;
    description: string | null;
    upload_date: string | null;
    duration_sec: number | null;
    view_count: number | null;
    like_count: number | null;
    language: string | null;
    available_caption_langs: string | null;
    tags_json: string | null;
    is_short: number;
    is_live: number;
    thumb_url: string | null;
    summary_short: string | null;
    summary_timestamped_json: string | null;
    audio_path: string | null;
    audio_size_bytes: number | null;
    audio_cached_at: string | null;
    video_path: string | null;
    video_size_bytes: number | null;
    video_cached_at: string | null;
    thumb_path: string | null;
    thumb_cached_at: string | null;
    created_at: string;
    updated_at: string;
}

interface VideoBinaryColumns {
    pathColumn: "audio_path" | "video_path" | "thumb_path";
    sizeColumn: "audio_size_bytes" | "video_size_bytes" | null;
    cachedAtColumn: "audio_cached_at" | "video_cached_at" | "thumb_cached_at";
}

function rowToVideo(row: VideoRow): Video {
    return {
        id: row.id,
        channelHandle: row.channel_handle,
        title: row.title,
        description: row.description,
        uploadDate: row.upload_date,
        durationSec: row.duration_sec,
        viewCount: row.view_count,
        likeCount: row.like_count,
        language: row.language,
        availableCaptionLangs: parseJsonArray(row.available_caption_langs),
        tags: parseJsonArray(row.tags_json),
        isShort: row.is_short === 1,
        isLive: row.is_live === 1,
        thumbUrl: row.thumb_url,
        summaryShort: row.summary_short,
        summaryTimestamped: parseNullableJsonArray<TimestampedSummaryEntry>(row.summary_timestamped_json),
        audioPath: row.audio_path,
        audioSizeBytes: row.audio_size_bytes,
        audioCachedAt: row.audio_cached_at,
        videoPath: row.video_path,
        videoSizeBytes: row.video_size_bytes,
        videoCachedAt: row.video_cached_at,
        thumbPath: row.thumb_path,
        thumbCachedAt: row.thumb_cached_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function videoBinaryColumns(kind: "audio" | "video" | "thumb"): VideoBinaryColumns {
    if (kind === "audio") {
        return { pathColumn: "audio_path", sizeColumn: "audio_size_bytes", cachedAtColumn: "audio_cached_at" };
    }

    if (kind === "video") {
        return { pathColumn: "video_path", sizeColumn: "video_size_bytes", cachedAtColumn: "video_cached_at" };
    }

    return { pathColumn: "thumb_path", sizeColumn: null, cachedAtColumn: "thumb_cached_at" };
}

function normalizeVideoBinaryPathInput(id: VideoId, kind: "audio" | "video" | "thumb" | undefined, path: string | null | undefined, sizeBytes: number | undefined): SetVideoBinaryPathInput {
    if (!kind) {
        throw new Error("setVideoBinaryPath requires a binary kind");
    }

    return {
        id,
        kind,
        path: path ?? null,
        sizeBytes,
    };
}

function normalizeVideoSummaryInput(id: VideoId, kind: "short" | "timestamped" | undefined, value: string | TimestampedSummaryEntry[] | undefined): SetVideoSummaryInput {
    if (!kind) {
        throw new Error("setVideoSummary requires a summary kind");
    }

    if (value === undefined) {
        throw new Error("setVideoSummary requires a value");
    }

    return {
        id,
        kind,
        value,
    };
}

function parseJsonArray(raw: string | null): string[] {
    if (!raw) {
        return [];
    }

    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
        return [];
    }

    return parsed.filter((item): item is string => typeof item === "string");
}

function parseNullableJsonArray<T>(raw: string | null): T[] | null {
    if (!raw) {
        return null;
    }

    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
        return null;
    }

    return parsed as T[];
}

interface PruneBinaryRow {
    id: VideoId;
    path: string | null;
}

interface TranscriptRow {
    id: number;
    video_id: VideoId;
    lang: Language;
    source: "captions" | "ai";
    text: string;
    segments_json: string | null;
    duration_sec: number | null;
    created_at: string;
}

interface TranscriptSearchRow {
    video_id: VideoId;
    lang: Language;
    snippet: string;
    rank: number;
}

interface QaChunkRow {
    id: number;
    video_id: VideoId;
    chunk_idx: number;
    text: string;
    start_sec: number | null;
    end_sec: number | null;
    embedding: Uint8Array | null;
    embedding_dims: number | null;
    embedder_model: string | null;
    created_at: string;
}

interface JobRow {
    id: number;
    target_kind: JobTargetKind;
    target: string;
    stages: string;
    current_stage: JobStage | null;
    status: JobStatus;
    error: string | null;
    progress: number;
    progress_message: string | null;
    parent_job_id: number | null;
    worker_id: string | null;
    claimed_at: string | null;
    created_at: string;
    updated_at: string;
    completed_at: string | null;
}

function rowToJob(row: JobRow): PipelineJob {
    return {
        id: row.id,
        targetKind: row.target_kind,
        target: row.target,
        stages: parseJobStages(row.stages),
        currentStage: row.current_stage,
        status: row.status,
        error: row.error,
        progress: row.progress,
        progressMessage: row.progress_message,
        parentJobId: row.parent_job_id,
        workerId: row.worker_id,
        claimedAt: row.claimed_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
    };
}

function parseJobStages(raw: string): JobStage[] {
    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
        return [];
    }

    return parsed.filter(isJobStage);
}

function isJobStage(value: unknown): value is JobStage {
    return value === "discover" || value === "metadata" || value === "captions" || value === "audio" || value === "transcribe" || value === "summarize";
}

function isTerminalJobStatus(status: JobStatus): boolean {
    return status === "completed" || status === "failed" || status === "cancelled";
}

function assertJobTransition(from: JobStatus, to: JobStatus, trigger: string): void {
    if (from === to) {
        return;
    }

    const allowed: Record<JobStatus, JobStatus[]> = {
        pending: ["running", "cancelled"],
        running: ["completed", "failed", "cancelled", "interrupted"],
        completed: [],
        failed: ["pending"],
        cancelled: [],
        interrupted: ["pending"],
    };

    if (!allowed[from].includes(to)) {
        throw new Error(`${trigger}: invalid job transition ${from} -> ${to}`);
    }
}

function rowToQaChunk(row: QaChunkRow): QaChunk {
    return {
        id: row.id,
        videoId: row.video_id,
        chunkIdx: row.chunk_idx,
        text: row.text,
        startSec: row.start_sec,
        endSec: row.end_sec,
        embedding: row.embedding ? new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / Float32Array.BYTES_PER_ELEMENT) : null,
        embeddingDims: row.embedding_dims,
        embedderModel: row.embedder_model,
        createdAt: row.created_at,
    };
}

function rowToTranscript(row: TranscriptRow): Transcript {
    return {
        id: row.id,
        videoId: row.video_id,
        lang: row.lang,
        source: row.source,
        text: row.text,
        segments: parseTranscriptSegments(row.segments_json),
        durationSec: row.duration_sec,
        createdAt: row.created_at,
    };
}

function parseTranscriptSegments(raw: string | null): TranscriptSegment[] {
    if (!raw) {
        return [];
    }

    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
        return [];
    }

    return parsed.filter(isTranscriptSegment);
}

function isTranscriptSegment(value: unknown): value is TranscriptSegment {
    if (!value || typeof value !== "object") {
        return false;
    }

    const candidate = value as { text?: unknown; start?: unknown; end?: unknown };

    return typeof candidate.text === "string" && typeof candidate.start === "number" && typeof candidate.end === "number";
}

interface ChannelRow {
    handle: ChannelHandle;
    channel_id: string | null;
    title: string | null;
    description: string | null;
    subscriber_count: number | null;
    thumb_url: string | null;
    last_synced_at: string | null;
    created_at: string;
    updated_at: string;
}

function rowToChannel(row: ChannelRow): Channel {
    return {
        handle: row.handle,
        channelId: row.channel_id,
        title: row.title,
        description: row.description,
        subscriberCount: row.subscriber_count,
        thumbUrl: row.thumb_url,
        lastSyncedAt: row.last_synced_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
