import { homedir } from "node:os";
import { join } from "node:path";
import { BaseDatabase } from "@app/utils/database";
import type { Channel, ChannelHandle, TimestampedSummaryEntry, Video, VideoId } from "@app/youtube/lib/types";

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

    initSchemaForTest(): void {
        this.initSchema();
    }
}

interface UpsertChannelInput {
    handle: ChannelHandle;
    channelId?: string | null;
    title?: string | null;
    description?: string | null;
    subscriberCount?: number | null;
    thumbUrl?: string | null;
}

interface UpsertVideoInput {
    id: VideoId;
    channelHandle: ChannelHandle;
    title: string;
    description?: string | null;
    uploadDate?: string | null;
    durationSec?: number | null;
    viewCount?: number | null;
    likeCount?: number | null;
    language?: string | null;
    availableCaptionLangs?: string[];
    tags?: string[];
    isShort?: boolean;
    isLive?: boolean;
    thumbUrl?: string | null;
}

interface ListVideosOpts {
    channel?: ChannelHandle;
    since?: string;
    includeShorts?: boolean;
    includeLive?: boolean;
    limit?: number;
    offset?: number;
}

interface SetVideoBinaryPathInput {
    id: VideoId;
    kind: "audio" | "video" | "thumb";
    path: string | null;
    sizeBytes?: number;
}

interface SetVideoSummaryInput {
    id: VideoId;
    kind: "short" | "timestamped";
    value: string | TimestampedSummaryEntry[];
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
