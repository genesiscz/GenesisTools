import { homedir } from "node:os";
import { join } from "node:path";
import { BaseDatabase, SQL_NOW_UTC } from "@app/utils/database";
import { SafeJSON } from "@app/utils/json";
import { withFileLock } from "@app/utils/storage";
import { deleteIfExists } from "@app/youtube/lib/cache";
import type { Channel, ChannelHandle } from "@app/youtube/lib/channel.types";
import type { FetchedComment, VideoComment } from "@app/youtube/lib/comments.types";
import type {
    ClaimJobOpts,
    EnqueueJobInput,
    GetTranscriptOpts,
    ListJobsOpts,
    ListVideosOpts,
    PruneExpiredBinariesOpts,
    PruneExpiredBinariesResult,
    RecordJobActivityInput,
    SaveTranscriptInput,
    SearchTranscriptsOpts,
    SearchVideosOpts,
    SetVideoBinaryPathInput,
    SetVideoSummaryInput,
    TranscriptSearchHit,
    UpdateJobPartial,
    UpsertChannelInput,
    UpsertQaChunkInput,
    UpsertVideoInput,
    VideoSearchField,
    VideoSearchHit,
} from "@app/youtube/lib/db.types";
import type {
    JobActivity,
    JobActivityKind,
    JobStage,
    JobStatus,
    JobTargetKind,
    PipelineJob,
} from "@app/youtube/lib/jobs.types";
import type { AskCitation, QaChunk, QaSource } from "@app/youtube/lib/qa.types";
import type { Language, Transcript, TranscriptSegment } from "@app/youtube/lib/transcript.types";
import type { ArtifactKind, CreditReason, QaHistoryItem, YtUser } from "@app/youtube/lib/users.types";
import { InsufficientCreditsError } from "@app/youtube/lib/users.types";
import type {
    TimestampedSummaryEntry,
    Video,
    VideoId,
    VideoLongSummary,
    VideoReport,
} from "@app/youtube/lib/video.types";

export const DEFAULT_DB_PATH = join(homedir(), ".genesis-tools", "youtube", "youtube.db");

const SCHEMA_VERSION = 2;

export class YoutubeDatabase extends BaseDatabase {
    constructor(dbPath: string = DEFAULT_DB_PATH) {
        super(dbPath);
    }

    protected initSchema(): void {
        this.db.exec(`
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC})
            );

            CREATE TABLE IF NOT EXISTS channels (
                handle TEXT PRIMARY KEY,
                channel_id TEXT,
                title TEXT,
                description TEXT,
                subscriber_count INTEGER,
                thumb_url TEXT,
                last_synced_at TEXT,
                created_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC}),
                updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC})
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
                summary_long_json TEXT,
                audio_path TEXT,
                audio_size_bytes INTEGER,
                audio_cached_at TEXT,
                video_path TEXT,
                video_size_bytes INTEGER,
                video_cached_at TEXT,
                thumb_path TEXT,
                thumb_cached_at TEXT,
                pinned INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC}),
                updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC}),
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
                created_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC}),
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
                created_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC}),
                updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC}),
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
                created_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC}),
                FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
                UNIQUE (video_id, chunk_idx, embedder_model)
            );
            CREATE INDEX IF NOT EXISTS idx_qa_chunks_video ON qa_chunks(video_id);

            CREATE TABLE IF NOT EXISTS job_activity (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER NOT NULL,
                stage TEXT,
                kind TEXT NOT NULL,
                action TEXT,
                provider TEXT,
                model TEXT,
                prompt TEXT,
                response TEXT,
                tokens_in INTEGER,
                tokens_out INTEGER,
                tokens_total INTEGER,
                cost_usd REAL,
                duration_ms INTEGER,
                started_at TEXT,
                completed_at TEXT,
                error TEXT,
                created_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC}),
                FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_job_activity_job ON job_activity(job_id, created_at DESC);
        `);

        this.runMigration("add-videos-pinned", () => {
            const cols = this.db.query<{ name: string }, []>("PRAGMA table_info(videos)").all() as Array<{
                name: string;
            }>;

            if (!cols.some((column) => column.name === "pinned")) {
                this.db.exec("ALTER TABLE videos ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
            }
        });

        this.runMigration("normalize-legacy-timestamps-utc", () => {
            this.normalizeLegacyTimestamps();
        });

        this.runMigration("add-videos-summary-long-json", () => {
            const cols = this.db.query<{ name: string }, []>("PRAGMA table_info(videos)").all() as Array<{
                name: string;
            }>;

            if (!cols.some((column) => column.name === "summary_long_json")) {
                this.db.exec("ALTER TABLE videos ADD COLUMN summary_long_json TEXT");
            }
        });

        this.runMigration("add-comments-table", () => {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS comments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    video_id TEXT NOT NULL,
                    comment_id TEXT NOT NULL,
                    author TEXT,
                    author_id TEXT,
                    text TEXT NOT NULL,
                    like_count INTEGER,
                    published_at TEXT,
                    parent_comment_id TEXT,
                    created_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC}),
                    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
                    UNIQUE (video_id, comment_id)
                );
                CREATE INDEX IF NOT EXISTS idx_comments_video ON comments(video_id);
            `);
        });

        this.runMigration("add-users-credits-qa-history", () => {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    password_hash TEXT NOT NULL,
                    api_token TEXT NOT NULL UNIQUE,
                    credits INTEGER NOT NULL DEFAULT 100,
                    created_at TEXT NOT NULL,
                    last_login_at TEXT
                );
                CREATE TABLE IF NOT EXISTS credit_ledger (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id),
                    delta INTEGER NOT NULL,
                    reason TEXT NOT NULL,
                    balance_after INTEGER NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS qa_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id),
                    video_id TEXT NOT NULL,
                    question TEXT NOT NULL,
                    answer TEXT NOT NULL,
                    citations_json TEXT NOT NULL DEFAULT '[]',
                    credits_spent INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_qa_history_user_video ON qa_history(user_id, video_id, id DESC);
            `);
        });

        this.runMigration("add-shares", () => {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS shares (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    slug TEXT NOT NULL UNIQUE,
                    user_id INTEGER NOT NULL REFERENCES users(id),
                    kind TEXT NOT NULL CHECK (kind IN ('summary','qa')),
                    video_id TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    revoked_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(user_id, id DESC);
            `);
        });

        this.runMigration("add-prompt-presets", () => {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS prompt_presets (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id),
                    name TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK (kind IN ('summary','insights','ask')),
                    instructions TEXT NOT NULL,
                    is_default INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    UNIQUE (user_id, kind, name)
                );
            `);
        });

        this.runMigration("add-qa-chunk-source", () => {
            const cols = this.db.query<{ name: string }, []>("PRAGMA table_info(qa_chunks)").all() as Array<{
                name: string;
            }>;

            if (!cols.some((column) => column.name === "source")) {
                this.db.exec("ALTER TABLE qa_chunks ADD COLUMN source TEXT NOT NULL DEFAULT 'transcript'");
            }

            if (!cols.some((column) => column.name === "source_ref")) {
                this.db.exec("ALTER TABLE qa_chunks ADD COLUMN source_ref TEXT");
            }

            this.db.exec("CREATE INDEX IF NOT EXISTS idx_qa_chunks_video_source ON qa_chunks(video_id, source)");

            // qa_history ask scope: citations_json is a plain array bag, so the
            // scope needs its own column (Feature 02 plan Task 3 fallback branch).
            const historyCols = this.db.query<{ name: string }, []>("PRAGMA table_info(qa_history)").all() as Array<{
                name: string;
            }>;

            if (!historyCols.some((column) => column.name === "sources_json")) {
                this.db.exec("ALTER TABLE qa_history ADD COLUMN sources_json TEXT");
            }
        });

        this.runMigration("add-qa-history-scope", () => {
            const cols = this.db.query<{ name: string }, []>("PRAGMA table_info(qa_history)").all() as Array<{
                name: string;
            }>;

            if (!cols.some((column) => column.name === "scope_json")) {
                this.db.exec("ALTER TABLE qa_history ADD COLUMN scope_json TEXT");
            }
        });

        this.runMigration("add-reports", () => {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS reports (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id),
                    title TEXT NOT NULL,
                    member_ids_json TEXT NOT NULL,
                    params_json TEXT,
                    result_json TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_reports_user ON reports(user_id, id DESC);
            `);
        });

        this.runMigration("add-artifact-access", () => {
            const tableExists = this.db
                .query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
                .get("artifact_access");

            if (tableExists) {
                return;
            }

            this.db.exec(`
                CREATE TABLE IF NOT EXISTS artifact_access (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id),
                    kind TEXT NOT NULL,            -- 'summary:long' | 'summary:short' | 'summary:timestamped' | 'transcript:ai'
                    video_id TEXT NOT NULL,
                    credits_spent INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE (user_id, kind, video_id)
                );
            `);
            // One-time backfill (guarded by the table-existence check above):
            // artifacts generated before access tracking have no owner — grant
            // every current user access so nobody is locked out of content
            // they could already see.
            this.db.exec(`
                INSERT OR IGNORE INTO artifact_access (user_id, kind, video_id, credits_spent, created_at)
                SELECT u.id, 'summary:short', v.id, 0, ${SQL_NOW_UTC}
                FROM users u, videos v WHERE v.summary_short IS NOT NULL;
                INSERT OR IGNORE INTO artifact_access (user_id, kind, video_id, credits_spent, created_at)
                SELECT u.id, 'summary:timestamped', v.id, 0, ${SQL_NOW_UTC}
                FROM users u, videos v WHERE v.summary_timestamped_json IS NOT NULL;
                INSERT OR IGNORE INTO artifact_access (user_id, kind, video_id, credits_spent, created_at)
                SELECT u.id, 'summary:long', v.id, 0, ${SQL_NOW_UTC}
                FROM users u, videos v WHERE v.summary_long_json IS NOT NULL;
                INSERT OR IGNORE INTO artifact_access (user_id, kind, video_id, credits_spent, created_at)
                SELECT u.id, 'transcript:ai', t.video_id, 0, ${SQL_NOW_UTC}
                FROM users u, transcripts t WHERE t.source = 'ai';
            `);
        });

        this.runMigration("add-video-speakers", () => {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS video_speakers (
                    video_id TEXT NOT NULL,
                    speaker_idx INTEGER NOT NULL,
                    label TEXT NOT NULL,
                    PRIMARY KEY (video_id, speaker_idx),
                    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
                );
            `);
        });

        const existing = this.db
            .query<{ version: number }, [number]>("SELECT version FROM schema_version WHERE version = ?")
            .get(SCHEMA_VERSION);

        if (!existing) {
            this.db.run("INSERT INTO schema_version (version) VALUES (?)", [SCHEMA_VERSION]);
        }
    }

    /**
     * Rewrites pre-`SQL_NOW_UTC` timestamp values (`'YYYY-MM-DD HH:MM:SS'`, no `T`/`Z`)
     * to ISO-8601 UTC (`'YYYY-MM-DDTHH:MM:SS.000Z'`). Idempotent: rows already in the
     * new format (`LIKE '%Z'` or containing `'T'`) are skipped.
     */
    private normalizeLegacyTimestamps(): void {
        const targets: Array<{ table: string; columns: string[] }> = [
            { table: "schema_version", columns: ["applied_at"] },
            { table: "channels", columns: ["last_synced_at", "created_at", "updated_at"] },
            {
                table: "videos",
                columns: ["audio_cached_at", "video_cached_at", "thumb_cached_at", "created_at", "updated_at"],
            },
            { table: "transcripts", columns: ["created_at"] },
            { table: "jobs", columns: ["claimed_at", "created_at", "updated_at", "completed_at"] },
            { table: "qa_chunks", columns: ["created_at"] },
        ];

        for (const { table, columns } of targets) {
            for (const column of columns) {
                this.db.run(
                    `UPDATE ${table}
                     SET ${column} = strftime('%Y-%m-%dT%H:%M:%fZ', ${column})
                     WHERE ${column} IS NOT NULL
                       AND ${column} NOT LIKE '%Z'
                       AND ${column} NOT LIKE '%T%'`
                );
            }
        }
    }

    private runMigration(_name: string, apply: () => void): void {
        try {
            apply();
        } catch (error) {
            throw new Error(`migration "${_name}" failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    upsertChannel(input: UpsertChannelInput): void {
        this.db.run(
            `INSERT INTO channels (handle, channel_id, title, description, subscriber_count, thumb_url, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ${SQL_NOW_UTC})
             ON CONFLICT(handle) DO UPDATE SET
                channel_id = COALESCE(excluded.channel_id, channels.channel_id),
                title = COALESCE(excluded.title, channels.title),
                description = COALESCE(excluded.description, channels.description),
                subscriber_count = COALESCE(excluded.subscriber_count, channels.subscriber_count),
                thumb_url = COALESCE(excluded.thumb_url, channels.thumb_url),
                updated_at = ${SQL_NOW_UTC}`,
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
        this.db.run(
            `UPDATE channels SET last_synced_at = ${SQL_NOW_UTC}, updated_at = ${SQL_NOW_UTC} WHERE handle = ?`,
            [handle]
        );
    }

    upsertVideo(input: UpsertVideoInput): void {
        this.db.run(
            `INSERT INTO videos (id, channel_handle, title, description, upload_date, duration_sec, view_count, like_count, language, available_caption_langs, tags_json, is_short, is_live, thumb_url, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${SQL_NOW_UTC})
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
                updated_at = ${SQL_NOW_UTC}`,
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
                input.availableCaptionLangs ? SafeJSON.stringify(input.availableCaptionLangs) : null,
                input.tags ? SafeJSON.stringify(input.tags) : null,
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

    /**
     * Returns videos whose `upload_date` is still NULL — these need a `dumpVideoMetadata`
     * pass to backfill the date (yt-dlp's flat-playlist listing doesn't carry it).
     */
    listVideosMissingUploadDate(opts: { channel?: ChannelHandle; limit?: number } = {}): Video[] {
        const where: string[] = ["upload_date IS NULL"];
        const params: Array<string | number> = [];

        if (opts.channel) {
            where.push("channel_handle = ?");
            params.push(opts.channel);
        }

        params.push(opts.limit ?? 100);
        const rows = this.db
            .query<VideoRow, Array<string | number>>(
                `SELECT * FROM videos WHERE ${where.join(" AND ")} ORDER BY created_at ASC LIMIT ?`
            )
            .all(...params);

        return rows.map(rowToVideo);
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
            .query<VideoRow, [...Array<string | number>, number, number]>(
                `SELECT * FROM videos ${whereClause} ORDER BY upload_date DESC LIMIT ? OFFSET ?`
            )
            .all(...params, limit, offset);

        return rows.map(rowToVideo);
    }

    setVideoBinaryPath(input: SetVideoBinaryPathInput): void;
    setVideoBinaryPath(id: VideoId, kind: "audio" | "video" | "thumb", path: string | null, sizeBytes?: number): void;
    setVideoBinaryPath(
        inputOrId: SetVideoBinaryPathInput | VideoId,
        kind?: "audio" | "video" | "thumb",
        path?: string | null,
        sizeBytes?: number
    ): void {
        const input =
            typeof inputOrId === "string" ? normalizeVideoBinaryPathInput(inputOrId, kind, path, sizeBytes) : inputOrId;
        const columns = videoBinaryColumns(input.kind);
        const cachedAt = input.path ? SQL_NOW_UTC : "NULL";

        if (columns.sizeColumn) {
            this.db.run(
                `UPDATE videos SET ${columns.pathColumn} = ?, ${columns.sizeColumn} = ?, ${columns.cachedAtColumn} = ${cachedAt}, updated_at = ${SQL_NOW_UTC} WHERE id = ?`,
                [input.path, input.path ? (input.sizeBytes ?? null) : null, input.id]
            );
        } else {
            this.db.run(
                `UPDATE videos SET ${columns.pathColumn} = ?, ${columns.cachedAtColumn} = ${cachedAt}, updated_at = ${SQL_NOW_UTC} WHERE id = ?`,
                [input.path, input.id]
            );
        }
    }

    setVideoSummary(input: SetVideoSummaryInput): void;
    setVideoSummary(
        id: VideoId,
        kind: "short" | "timestamped" | "long",
        value: string | TimestampedSummaryEntry[] | VideoLongSummary
    ): void;
    setVideoSummary(
        inputOrId: SetVideoSummaryInput | VideoId,
        kind?: "short" | "timestamped" | "long",
        value?: string | TimestampedSummaryEntry[] | VideoLongSummary
    ): void {
        const input = typeof inputOrId === "string" ? normalizeVideoSummaryInput(inputOrId, kind, value) : inputOrId;
        const column =
            input.kind === "short"
                ? "summary_short"
                : input.kind === "timestamped"
                  ? "summary_timestamped_json"
                  : "summary_long_json";
        const serialized = typeof input.value === "string" ? input.value : SafeJSON.stringify(input.value);

        this.db.run(`UPDATE videos SET ${column} = ?, updated_at = ${SQL_NOW_UTC} WHERE id = ?`, [
            serialized,
            input.id,
        ]);
    }

    saveTranscript(input: SaveTranscriptInput): void {
        this.db.run(
            `INSERT INTO transcripts (video_id, lang, source, text, segments_json, duration_sec)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(video_id, lang, source) DO UPDATE SET
                text = excluded.text,
                segments_json = excluded.segments_json,
                duration_sec = excluded.duration_sec,
                created_at = ${SQL_NOW_UTC}`,
            [
                input.videoId,
                input.lang,
                input.source,
                input.text,
                SafeJSON.stringify(input.segments),
                input.durationSec ?? null,
            ]
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
        const rows = this.db
            .query<TranscriptRow, [string]>("SELECT * FROM transcripts WHERE video_id = ? ORDER BY lang, source")
            .all(videoId);

        return rows.map(rowToTranscript);
    }

    upsertVideoSpeakers(videoId: VideoId, speakers: Array<{ idx: number; label: string }>): void {
        const insert = this.db.prepare(
            `INSERT INTO video_speakers (video_id, speaker_idx, label)
             VALUES (?, ?, ?)
             ON CONFLICT(video_id, speaker_idx) DO UPDATE SET label = excluded.label`
        );
        const insertAll = this.db.transaction((rows: Array<{ idx: number; label: string }>) => {
            for (const row of rows) {
                insert.run(videoId, row.idx, row.label);
            }
        });
        insertAll(speakers);
    }

    getVideoSpeakers(videoId: VideoId): Record<number, string> {
        const rows = this.db
            .query<{ speaker_idx: number; label: string }, [string]>(
                "SELECT speaker_idx, label FROM video_speakers WHERE video_id = ? ORDER BY speaker_idx"
            )
            .all(videoId);
        const labels: Record<number, string> = {};

        for (const row of rows) {
            labels[row.speaker_idx] = row.label;
        }

        return labels;
    }

    upsertComments(videoId: VideoId, comments: FetchedComment[]): void {
        const insert = this.db.prepare(
            `INSERT INTO comments (video_id, comment_id, author, author_id, text, like_count, published_at, parent_comment_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(video_id, comment_id) DO UPDATE SET
                author = excluded.author,
                author_id = excluded.author_id,
                text = excluded.text,
                like_count = excluded.like_count,
                published_at = excluded.published_at,
                parent_comment_id = excluded.parent_comment_id`
        );
        const insertAll = this.db.transaction((rows: FetchedComment[]) => {
            for (const row of rows) {
                insert.run(
                    videoId,
                    row.commentId,
                    row.author,
                    row.authorId,
                    row.text,
                    row.likeCount,
                    row.publishedAt,
                    row.parentCommentId
                );
            }
        });

        insertAll(comments);
    }

    getComments(videoId: VideoId): VideoComment[] {
        const rows = this.db
            .query<CommentRow, [string]>("SELECT * FROM comments WHERE video_id = ? ORDER BY id ASC")
            .all(videoId);

        return rows.map(rowToComment);
    }

    searchVideos(query: string, opts: SearchVideosOpts = {}): VideoSearchHit[] {
        const fields = opts.fields?.length ? opts.fields : (["title", "description", "tags"] as VideoSearchField[]);
        const limit = opts.limit ?? 50;
        const term = `%${escapeLike(query)}%`;
        const where: string[] = [];
        const params: Array<string | number> = [];
        const orParts: string[] = [];

        for (const field of fields) {
            const column = videoSearchColumn(field);
            orParts.push(`${column} LIKE ? ESCAPE '\\'`);
            params.push(term);
        }

        where.push(`(${orParts.join(" OR ")})`);

        if (opts.channel) {
            where.push("channel_handle = ?");
            params.push(opts.channel);
        }

        if (!opts.includeShorts) {
            where.push("is_short = 0");
        }

        if (!opts.includeLive) {
            where.push("is_live = 0");
        }

        params.push(limit);
        const rows = this.db
            .query<VideoSearchRow, Array<string | number>>(
                `SELECT id, channel_handle, title, description, tags_json
                 FROM videos
                 WHERE ${where.join(" AND ")}
                 ORDER BY upload_date DESC NULLS LAST
                 LIMIT ?`
            )
            .all(...params);
        const lowered = query.toLowerCase();

        return rows.flatMap((row) => buildVideoHits(row, fields, lowered));
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
        const embedding = input.embedding
            ? Buffer.from(input.embedding.buffer, input.embedding.byteOffset, input.embedding.byteLength)
            : null;
        const embeddingDims = input.embedding ? input.embedding.length : null;

        this.db.run(
            `INSERT INTO qa_chunks (video_id, chunk_idx, text, start_sec, end_sec, embedding, embedding_dims, embedder_model, source, source_ref)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(video_id, chunk_idx, embedder_model) DO UPDATE SET
                text = excluded.text,
                start_sec = excluded.start_sec,
                end_sec = excluded.end_sec,
                embedding = excluded.embedding,
                embedding_dims = excluded.embedding_dims,
                source = excluded.source,
                source_ref = excluded.source_ref`,
            [
                input.videoId,
                input.chunkIdx,
                input.text,
                input.startSec ?? null,
                input.endSec ?? null,
                embedding,
                embeddingDims,
                input.embedderModel ?? null,
                input.source ?? "transcript",
                input.sourceRef ?? null,
            ]
        );
    }

    listQaChunks(videoId: VideoId, embedderModel?: string): QaChunk[] {
        const rows = embedderModel
            ? this.db
                  .query<QaChunkRow, [string, string]>(
                      "SELECT * FROM qa_chunks WHERE video_id = ? AND embedder_model = ? ORDER BY chunk_idx"
                  )
                  .all(videoId, embedderModel)
            : this.db
                  .query<QaChunkRow, [string]>("SELECT * FROM qa_chunks WHERE video_id = ? ORDER BY chunk_idx")
                  .all(videoId);

        return rows.map(rowToQaChunk);
    }

    hasQaChunks(videoId: VideoId, embedderModel?: string, source?: QaSource): boolean {
        const where: string[] = ["video_id = ?"];
        const params: string[] = [videoId];

        if (embedderModel) {
            where.push("embedder_model = ?");
            params.push(embedderModel);
        }

        if (source) {
            where.push("source = ?");
            params.push(source);
        }

        const row = this.db
            .query<{ count: number }, string[]>(`SELECT COUNT(*) AS count FROM qa_chunks WHERE ${where.join(" AND ")}`)
            .get(...params);

        return (row?.count ?? 0) > 0;
    }

    enqueueJob(input: EnqueueJobInput): PipelineJob {
        const result = this.db
            .query<{ id: number }, [string, string, string, number | null]>(
                `INSERT INTO jobs (target_kind, target, stages, parent_job_id, status)
                 VALUES (?, ?, ?, ?, 'pending') RETURNING id`
            )
            .get(input.targetKind, input.target, SafeJSON.stringify(input.stages), input.parentJobId ?? null);

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
        const stageClause = opts.stage ? "AND json_extract(jobs.stages, '$[0]') = ?" : "";
        const row = opts.stage
            ? this.db
                  .query<JobRow, [string, string]>(
                      `UPDATE jobs SET status = 'running', worker_id = ?, claimed_at = ${SQL_NOW_UTC}, updated_at = ${SQL_NOW_UTC}
                       WHERE id = (
                           SELECT id FROM jobs WHERE status = 'pending' ${stageClause} ORDER BY id ASC LIMIT 1
                       )
                       RETURNING *`
                  )
                  .get(workerId, opts.stage)
            : this.db
                  .query<JobRow, [string]>(
                      `UPDATE jobs SET status = 'running', worker_id = ?, claimed_at = ${SQL_NOW_UTC}, updated_at = ${SQL_NOW_UTC}
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
                sets.push(`completed_at = ${SQL_NOW_UTC}`);
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

        sets.push(`updated_at = ${SQL_NOW_UTC}`);
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
        const rows = this.db
            .query<JobRow, [...Array<string | number>, number, number]>(
                `SELECT * FROM jobs ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`
            )
            .all(...params, limit, offset);

        return rows.map(rowToJob);
    }

    markInterruptedJobsForRequeue(): number {
        const result = this.db.run(
            `UPDATE jobs SET status = 'pending', worker_id = NULL, claimed_at = NULL, current_stage = NULL,
                             progress = 0, progress_message = NULL, updated_at = ${SQL_NOW_UTC}
             WHERE status = 'running'`
        );

        return result.changes;
    }

    advanceJobToNextStage(id: number, remainingStages: JobStage[]): void {
        if (remainingStages.length === 0) {
            throw new Error(`advanceJobToNextStage: id=${id} called with empty remainingStages`);
        }

        this.db.run(
            `UPDATE jobs SET stages = ?, status = 'pending', worker_id = NULL, claimed_at = NULL,
                             current_stage = NULL, progress = 0, progress_message = NULL,
                             updated_at = ${SQL_NOW_UTC}
             WHERE id = ?`,
            [SafeJSON.stringify(remainingStages), id]
        );
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
        this.db.run(
            `UPDATE jobs SET status = 'cancelled', completed_at = ${SQL_NOW_UTC}, updated_at = ${SQL_NOW_UTC} WHERE id = ?`,
            [id]
        );
    }

    recordJobActivity(input: RecordJobActivityInput): JobActivity {
        const result = this.db
            .query<{ id: number }, Array<string | number | null>>(
                `INSERT INTO job_activity
                    (job_id, stage, kind, action, provider, model, prompt, response,
                     tokens_in, tokens_out, tokens_total, cost_usd,
                     duration_ms, started_at, completed_at, error)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
            )
            .get(
                input.jobId,
                input.stage ?? null,
                input.kind,
                input.action ?? null,
                input.provider ?? null,
                input.model ?? null,
                input.prompt ?? null,
                input.response ?? null,
                input.tokensIn ?? null,
                input.tokensOut ?? null,
                input.tokensTotal ?? null,
                input.costUsd ?? null,
                input.durationMs ?? null,
                input.startedAt ?? null,
                input.completedAt ?? null,
                input.error ?? null
            );

        if (!result) {
            throw new Error("recordJobActivity failed: insert returned no id");
        }

        const row = this.db.query<JobActivityRow, [number]>("SELECT * FROM job_activity WHERE id = ?").get(result.id);

        if (!row) {
            throw new Error(`recordJobActivity: inserted id=${result.id} but read returned null`);
        }

        return rowToJobActivity(row);
    }

    listJobActivity(jobId: number): JobActivity[] {
        const rows = this.db
            .query<JobActivityRow, [number]>("SELECT * FROM job_activity WHERE job_id = ? ORDER BY id ASC")
            .all(jobId);

        return rows.map(rowToJobActivity);
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
        const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
        const rows = this.db
            .query<PruneBinaryRow, [string]>(
                `SELECT id, ${columns.pathColumn} AS path
                 FROM videos
                 WHERE ${columns.pathColumn} IS NOT NULL AND ${columns.cachedAtColumn} < ? AND pinned = 0
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

    setVideoPinned(id: VideoId, pinned: boolean): void {
        this.db.run(`UPDATE videos SET pinned = ?, updated_at = ${SQL_NOW_UTC} WHERE id = ?`, [pinned ? 1 : 0, id]);
    }

    private clearVideoBinaryPath(id: VideoId, kind: "audio" | "video" | "thumb"): void {
        const columns = videoBinaryColumns(kind);

        if (columns.sizeColumn) {
            this.db.run(
                `UPDATE videos SET ${columns.pathColumn} = NULL, ${columns.sizeColumn} = NULL, ${columns.cachedAtColumn} = NULL, updated_at = ${SQL_NOW_UTC} WHERE id = ?`,
                [id]
            );
        } else {
            this.db.run(
                `UPDATE videos SET ${columns.pathColumn} = NULL, ${columns.cachedAtColumn} = NULL, updated_at = ${SQL_NOW_UTC} WHERE id = ?`,
                [id]
            );
        }
    }

    createUser(input: { email: string; passwordHash: string; apiToken: string }): YtUser {
        // Credits start at 0 (not the column DEFAULT) so the register grant goes
        // through the ledger and SUM(delta) always reconciles to the balance.
        const row = this.db
            .query<UserRow, [string, string, string]>(
                `INSERT INTO users (email, password_hash, api_token, credits, created_at)
                 VALUES (?, ?, ?, 0, ${SQL_NOW_UTC}) RETURNING *`
            )
            .get(input.email, input.passwordHash, input.apiToken);

        if (!row) {
            throw new Error("createUser failed: insert returned no row");
        }

        return rowToUser(row);
    }

    getUserByEmail(email: string): (YtUser & { passwordHash: string; apiToken: string }) | null {
        const row = this.db.query<UserRow, [string]>("SELECT * FROM users WHERE email = ?").get(email);

        if (!row) {
            return null;
        }

        return { ...rowToUser(row), passwordHash: row.password_hash, apiToken: row.api_token };
    }

    getUserByToken(apiToken: string): YtUser | null {
        const row = this.db.query<UserRow, [string]>("SELECT * FROM users WHERE api_token = ?").get(apiToken);

        return row ? rowToUser(row) : null;
    }

    touchUserLogin(id: number): void {
        this.db.run(`UPDATE users SET last_login_at = ${SQL_NOW_UTC} WHERE id = ?`, [id]);
    }

    /**
     * Atomic conditional debit: only succeeds while the balance covers the
     * amount; throws `InsufficientCreditsError` otherwise. Ledger row is
     * written in the same transaction.
     */
    spendCredits(userId: number, amount: number, reason: CreditReason): number {
        const spend = this.db.transaction(() => {
            const row = this.db
                .query<{ credits: number }, [number, number, number]>(
                    "UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ? RETURNING credits"
                )
                .get(amount, userId, amount);

            if (!row) {
                const current = this.db
                    .query<{ credits: number }, [number]>("SELECT credits FROM users WHERE id = ?")
                    .get(userId);
                throw new InsufficientCreditsError(current?.credits ?? 0, amount);
            }

            this.writeCreditLedger(userId, -amount, reason, row.credits);
            return row.credits;
        });

        return spend();
    }

    /** Unconditional credit; writes the ledger row; returns the new balance. */
    grantCredits(userId: number, amount: number, reason: CreditReason): number {
        const grant = this.db.transaction(() => {
            const row = this.db
                .query<{ credits: number }, [number, number]>(
                    "UPDATE users SET credits = credits + ? WHERE id = ? RETURNING credits"
                )
                .get(amount, userId);

            if (!row) {
                throw new Error(`grantCredits: user ${userId} not found`);
            }

            this.writeCreditLedger(userId, amount, reason, row.credits);
            return row.credits;
        });

        return grant();
    }

    /** Idempotency check for external-event-driven grants (e.g. Stripe webhooks). */
    hasLedgerReason(userId: number, reason: string): boolean {
        const row = this.db
            .query<{ found: number }, [number, string]>(
                "SELECT 1 AS found FROM credit_ledger WHERE user_id = ? AND reason = ? LIMIT 1"
            )
            .get(userId, reason);

        return row !== null;
    }

    private writeCreditLedger(userId: number, delta: number, reason: CreditReason, balanceAfter: number): void {
        this.db.run(
            `INSERT INTO credit_ledger (user_id, delta, reason, balance_after, created_at)
             VALUES (?, ?, ?, ?, ${SQL_NOW_UTC})`,
            [userId, delta, reason, balanceAfter]
        );
    }

    insertQaHistory(input: {
        userId: number;
        videoId: string;
        question: string;
        answer: string;
        citations: AskCitation[];
        creditsSpent: number;
        sources?: QaSource[];
        scope?: "video" | "channel";
        candidateVideoIds?: string[];
    }): QaHistoryItem {
        const scopeJson = input.scope
            ? SafeJSON.stringify({ scope: input.scope, candidateVideoIds: input.candidateVideoIds })
            : null;
        const row = this.db
            .query<QaHistoryRow, [number, string, string, string, string, number, string | null, string | null]>(
                `INSERT INTO qa_history (user_id, video_id, question, answer, citations_json, credits_spent, sources_json, scope_json, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${SQL_NOW_UTC}) RETURNING *`
            )
            .get(
                input.userId,
                input.videoId,
                input.question,
                input.answer,
                SafeJSON.stringify(input.citations),
                input.creditsSpent,
                input.sources ? SafeJSON.stringify(input.sources) : null,
                scopeJson
            );

        if (!row) {
            throw new Error("insertQaHistory failed: insert returned no row");
        }

        return rowToQaHistoryItem(row);
    }

    /** Newest first. `videoId` narrows to one video; `limit` defaults to 100. */
    listQaHistory(userId: number, videoId?: string, limit?: number): QaHistoryItem[] {
        const max = limit ?? 100;
        const rows = videoId
            ? this.db
                  .query<QaHistoryRow, [number, string, number]>(
                      "SELECT * FROM qa_history WHERE user_id = ? AND video_id = ? ORDER BY id DESC LIMIT ?"
                  )
                  .all(userId, videoId, max)
            : this.db
                  .query<QaHistoryRow, [number, number]>(
                      "SELECT * FROM qa_history WHERE user_id = ? ORDER BY id DESC LIMIT ?"
                  )
                  .all(userId, max);

        return rows.map(rowToQaHistoryItem);
    }

    /**
     * Best-effort context join for a ledger row: the nearest `qa_history` row
     * for this user within a 2-second window of `createdAt`. `credit_ledger`
     * carries no video/question reference of its own, so this proximity match
     * is the only way to recover "what was this ask spend for" — nullable by
     * design (Feature 09, ledger-views.ts).
     */
    findQaForLedgerRow(userId: number, createdAt: string): QaHistoryItem | null {
        const row = this.db
            .query<QaHistoryRow, [number, string, string]>(
                `SELECT * FROM qa_history
                 WHERE user_id = ?
                   AND ABS(strftime('%s', created_at) - strftime('%s', ?)) <= 2
                 ORDER BY ABS(strftime('%s', created_at) - strftime('%s', ?)) ASC
                 LIMIT 1`
            )
            .get(userId, createdAt, createdAt);

        return row ? rowToQaHistoryItem(row) : null;
    }

    /** Ownership-scoped lookup — returns null for another user's row (Feature 10 share creation). */
    getQaHistoryById(userId: number, id: number): QaHistoryItem | null {
        const row = this.db
            .query<QaHistoryRow, [number, number]>("SELECT * FROM qa_history WHERE id = ? AND user_id = ?")
            .get(id, userId);

        return row ? rowToQaHistoryItem(row) : null;
    }

    createShareRow(input: {
        slug: string;
        userId: number;
        kind: "summary" | "qa";
        videoId: string;
        payloadJson: string;
    }): ShareRow {
        const row = this.db
            .query<ShareRow, [string, number, string, string, string]>(
                `INSERT INTO shares (slug, user_id, kind, video_id, payload_json, created_at)
                 VALUES (?, ?, ?, ?, ?, ${SQL_NOW_UTC}) RETURNING *`
            )
            .get(input.slug, input.userId, input.kind, input.videoId, input.payloadJson);

        if (!row) {
            throw new Error("createShareRow failed: insert returned no row");
        }

        return row;
    }

    getShareBySlug(slug: string): ShareRow | null {
        return this.db.query<ShareRow, [string]>("SELECT * FROM shares WHERE slug = ?").get(slug);
    }

    /** Newest first. */
    listSharesForUser(userId: number): ShareRow[] {
        return this.db.query<ShareRow, [number]>("SELECT * FROM shares WHERE user_id = ? ORDER BY id DESC").all(userId);
    }

    /** Sets `revoked_at` if the slug belongs to `userId` and isn't already revoked. Returns whether it revoked. */
    revokeShareRow(userId: number, slug: string): boolean {
        const result = this.db.run(
            `UPDATE shares SET revoked_at = ${SQL_NOW_UTC}
             WHERE slug = ? AND user_id = ? AND revoked_at IS NULL`,
            [slug, userId]
        );

        return result.changes > 0;
    }

    /** Count of shares created by `userId` since `sinceIso` — backs the 10/hour rate limit. */
    countSharesSince(userId: number, sinceIso: string): number {
        const row = this.db
            .query<{ count: number }, [number, string]>(
                "SELECT COUNT(*) AS count FROM shares WHERE user_id = ? AND created_at >= ?"
            )
            .get(userId, sinceIso);

        return row?.count ?? 0;
    }

    createPresetRow(input: { userId: number; name: string; kind: PresetRow["kind"]; instructions: string }): PresetRow {
        const row = this.db
            .query<PresetRow, [number, string, string, string]>(
                `INSERT INTO prompt_presets (user_id, name, kind, instructions, created_at)
                 VALUES (?, ?, ?, ?, ${SQL_NOW_UTC}) RETURNING *`
            )
            .get(input.userId, input.name, input.kind, input.instructions);

        if (!row) {
            throw new Error("createPresetRow failed: insert returned no row");
        }

        return row;
    }

    /** Newest first. */
    listPresetsForUser(userId: number, kind?: PresetRow["kind"]): PresetRow[] {
        return kind
            ? this.db
                  .query<PresetRow, [number, string]>(
                      "SELECT * FROM prompt_presets WHERE user_id = ? AND kind = ? ORDER BY id DESC"
                  )
                  .all(userId, kind)
            : this.db
                  .query<PresetRow, [number]>("SELECT * FROM prompt_presets WHERE user_id = ? ORDER BY id DESC")
                  .all(userId);
    }

    /** Ownership-scoped lookup — returns null for another user's preset. */
    getPresetById(userId: number, id: number): PresetRow | null {
        return this.db
            .query<PresetRow, [number, number]>("SELECT * FROM prompt_presets WHERE id = ? AND user_id = ?")
            .get(id, userId);
    }

    /** Returns null if the preset doesn't exist or isn't owned by `userId`. */
    updatePresetRow(userId: number, id: number, partial: { name?: string; instructions?: string }): PresetRow | null {
        const existing = this.getPresetById(userId, id);

        if (!existing) {
            return null;
        }

        return this.db
            .query<PresetRow, [string, string, number, number]>(
                "UPDATE prompt_presets SET name = ?, instructions = ? WHERE id = ? AND user_id = ? RETURNING *"
            )
            .get(partial.name ?? existing.name, partial.instructions ?? existing.instructions, id, userId);
    }

    deletePresetRow(userId: number, id: number): boolean {
        const result = this.db.run("DELETE FROM prompt_presets WHERE id = ? AND user_id = ?", [id, userId]);
        return result.changes > 0;
    }

    countPresetsForUser(userId: number): number {
        const row = this.db
            .query<{ count: number }, [number]>("SELECT COUNT(*) AS count FROM prompt_presets WHERE user_id = ?")
            .get(userId);

        return row?.count ?? 0;
    }

    /** True when the LLM-produced artifact itself exists — regardless of who may access it. */
    hasArtifact(kind: ArtifactKind, videoId: string): boolean {
        if (kind === "transcript:ai") {
            const row = this.db
                .query<{ found: number }, [string]>(
                    "SELECT 1 AS found FROM transcripts WHERE video_id = ? AND source = 'ai' LIMIT 1"
                )
                .get(videoId);

            return row !== null;
        }

        const column =
            kind === "summary:short"
                ? "summary_short"
                : kind === "summary:timestamped"
                  ? "summary_timestamped_json"
                  : "summary_long_json";
        const row = this.db
            .query<{ found: number }, [string]>(`SELECT 1 AS found FROM videos WHERE id = ? AND ${column} IS NOT NULL`)
            .get(videoId);

        return row !== null;
    }

    hasArtifactAccess(userId: number, kind: ArtifactKind, videoId: string): boolean {
        const row = this.db
            .query<{ found: number }, [number, string, string]>(
                "SELECT 1 AS found FROM artifact_access WHERE user_id = ? AND kind = ? AND video_id = ?"
            )
            .get(userId, kind, videoId);

        return row !== null;
    }

    /** Idempotent (INSERT OR IGNORE on the UNIQUE key) — a second grant keeps the first row. */
    insertArtifactAccess(input: { userId: number; kind: ArtifactKind; videoId: string; creditsSpent: number }): void {
        this.db.run(
            `INSERT OR IGNORE INTO artifact_access (user_id, kind, video_id, credits_spent, created_at)
             VALUES (?, ?, ?, ?, ${SQL_NOW_UTC})`,
            [input.userId, input.kind, input.videoId, input.creditsSpent]
        );
    }

    insertReport(input: {
        userId: number;
        title: string;
        memberIds: string[];
        params?: Record<string, unknown> | null;
    }): VideoReportRecord {
        const row = this.db
            .query<ReportRow, [number, string, string, string | null]>(
                `INSERT INTO reports (user_id, title, member_ids_json, params_json, created_at)
                 VALUES (?, ?, ?, ?, ${SQL_NOW_UTC}) RETURNING *`
            )
            .get(
                input.userId,
                input.title,
                SafeJSON.stringify(input.memberIds),
                input.params ? SafeJSON.stringify(input.params) : null
            );

        if (!row) {
            throw new Error("insertReport failed: insert returned no row");
        }

        return rowToReport(row);
    }

    getReport(id: number): VideoReportRecord | null {
        const row = this.db.query<ReportRow, [number]>("SELECT * FROM reports WHERE id = ?").get(id);

        return row ? rowToReport(row) : null;
    }

    listReports(userId: number, limit = 50): VideoReportRecord[] {
        const rows = this.db
            .query<ReportRow, [number, number]>("SELECT * FROM reports WHERE user_id = ? ORDER BY id DESC LIMIT ?")
            .all(userId, limit);

        return rows.map(rowToReport);
    }

    setReportResult(id: number, result: VideoReport): void {
        this.db.run("UPDATE reports SET result_json = ? WHERE id = ?", [SafeJSON.stringify(result), id]);
    }

    initSchemaForTest(): void {
        this.initSchema();
    }
}

export interface PresetRow {
    id: number;
    user_id: number;
    name: string;
    kind: "summary" | "insights" | "ask";
    instructions: string;
    is_default: number;
    created_at: string;
}

export interface ShareRow {
    id: number;
    slug: string;
    user_id: number;
    kind: "summary" | "qa";
    video_id: string;
    payload_json: string;
    created_at: string;
    revoked_at: string | null;
}

export interface VideoReportRecord {
    id: number;
    userId: number;
    title: string;
    memberIds: string[];
    params: Record<string, unknown> | null;
    result: VideoReport | null;
    createdAt: string;
}

interface ReportRow {
    id: number;
    user_id: number;
    title: string;
    member_ids_json: string;
    params_json: string | null;
    result_json: string | null;
    created_at: string;
}

function rowToReport(row: ReportRow): VideoReportRecord {
    return {
        id: row.id,
        userId: row.user_id,
        title: row.title,
        memberIds: parseNullableJsonArray<string>(row.member_ids_json) ?? [],
        params: row.params_json ? (SafeJSON.parse(row.params_json) as Record<string, unknown>) : null,
        result: row.result_json ? (SafeJSON.parse(row.result_json) as VideoReport) : null,
        createdAt: row.created_at,
    };
}

interface UserRow {
    id: number;
    email: string;
    password_hash: string;
    api_token: string;
    credits: number;
    created_at: string;
    last_login_at: string | null;
}

function rowToUser(row: UserRow): YtUser {
    return {
        id: row.id,
        email: row.email,
        credits: row.credits,
        createdAt: row.created_at,
    };
}

interface QaHistoryRow {
    id: number;
    user_id: number;
    video_id: string;
    question: string;
    answer: string;
    citations_json: string;
    credits_spent: number;
    created_at: string;
    sources_json: string | null;
    scope_json: string | null;
}

function rowToQaHistoryItem(row: QaHistoryRow): QaHistoryItem {
    const scope = parseQaHistoryScope(row.scope_json);

    return {
        id: row.id,
        videoId: row.video_id,
        question: row.question,
        answer: row.answer,
        citations: parseNullableJsonArray<AskCitation>(row.citations_json) ?? [],
        creditsSpent: row.credits_spent,
        createdAt: row.created_at,
        sources: parseNullableJsonArray<QaSource>(row.sources_json) ?? undefined,
        scope: scope?.scope,
        candidateVideoIds: scope?.candidateVideoIds,
    };
}

function parseQaHistoryScope(raw: string | null): { scope: "video" | "channel"; candidateVideoIds?: string[] } | null {
    if (!raw) {
        return null;
    }

    const parsed = SafeJSON.parse(raw) as { scope?: unknown; candidateVideoIds?: unknown };

    if (parsed?.scope !== "video" && parsed?.scope !== "channel") {
        return null;
    }

    return {
        scope: parsed.scope,
        candidateVideoIds: Array.isArray(parsed.candidateVideoIds)
            ? parsed.candidateVideoIds.filter((value): value is string => typeof value === "string")
            : undefined,
    };
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
    summary_long_json: string | null;
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
        summaryLong: parseNullableJson<VideoLongSummary>(row.summary_long_json),
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

function normalizeVideoBinaryPathInput(
    id: VideoId,
    kind: "audio" | "video" | "thumb" | undefined,
    path: string | null | undefined,
    sizeBytes: number | undefined
): SetVideoBinaryPathInput {
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

function normalizeVideoSummaryInput(
    id: VideoId,
    kind: "short" | "timestamped" | "long" | undefined,
    value: string | TimestampedSummaryEntry[] | VideoLongSummary | undefined
): SetVideoSummaryInput {
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

    const parsed = SafeJSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
        return [];
    }

    return parsed.filter((item): item is string => typeof item === "string");
}

function parseNullableJsonArray<T>(raw: string | null): T[] | null {
    if (!raw) {
        return null;
    }

    const parsed = SafeJSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
        return null;
    }

    return parsed as T[];
}

function parseNullableJson<T>(raw: string | null): T | null {
    if (!raw) {
        return null;
    }

    try {
        return SafeJSON.parse(raw) as T;
    } catch {
        return null;
    }
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

interface CommentRow {
    id: number;
    video_id: VideoId;
    comment_id: string;
    author: string | null;
    author_id: string | null;
    text: string;
    like_count: number | null;
    published_at: string | null;
    parent_comment_id: string | null;
    created_at: string;
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
    source: QaSource;
    source_ref: string | null;
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
    const parsed = SafeJSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
        return [];
    }

    return parsed.filter(isJobStage);
}

function isJobStage(value: unknown): value is JobStage {
    return (
        value === "discover" ||
        value === "metadata" ||
        value === "comments" ||
        value === "captions" ||
        value === "audio" ||
        value === "video" ||
        value === "transcribe" ||
        value === "summarize" ||
        value === "reportSynthesize"
    );
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
        embedding: row.embedding
            ? new Float32Array(
                  row.embedding.buffer,
                  row.embedding.byteOffset,
                  row.embedding.byteLength / Float32Array.BYTES_PER_ELEMENT
              )
            : null,
        embeddingDims: row.embedding_dims,
        embedderModel: row.embedder_model,
        createdAt: row.created_at,
        source: row.source ?? "transcript",
        sourceRef: row.source_ref ?? null,
    };
}

function rowToComment(row: CommentRow): VideoComment {
    return {
        id: row.id,
        videoId: row.video_id,
        commentId: row.comment_id,
        author: row.author,
        authorId: row.author_id,
        text: row.text,
        likeCount: row.like_count,
        publishedAt: row.published_at,
        parentCommentId: row.parent_comment_id,
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

    const parsed = SafeJSON.parse(raw) as unknown;

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

    return (
        typeof candidate.text === "string" && typeof candidate.start === "number" && typeof candidate.end === "number"
    );
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

interface JobActivityRow {
    id: number;
    job_id: number;
    stage: string | null;
    kind: string;
    action: string | null;
    provider: string | null;
    model: string | null;
    prompt: string | null;
    response: string | null;
    tokens_in: number | null;
    tokens_out: number | null;
    tokens_total: number | null;
    cost_usd: number | null;
    duration_ms: number | null;
    started_at: string | null;
    completed_at: string | null;
    error: string | null;
    created_at: string;
}

function rowToJobActivity(row: JobActivityRow): JobActivity {
    return {
        id: row.id,
        jobId: row.job_id,
        stage: isJobStage(row.stage) ? row.stage : null,
        kind: isJobActivityKind(row.kind) ? row.kind : "llm",
        action: row.action,
        provider: row.provider,
        model: row.model,
        prompt: row.prompt,
        response: row.response,
        tokensIn: row.tokens_in,
        tokensOut: row.tokens_out,
        tokensTotal: row.tokens_total,
        costUsd: row.cost_usd,
        durationMs: row.duration_ms,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        error: row.error,
        createdAt: row.created_at,
    };
}

function isJobActivityKind(value: unknown): value is JobActivityKind {
    return value === "llm" || value === "embed" || value === "transcribe";
}

interface VideoSearchRow {
    id: VideoId;
    channel_handle: ChannelHandle;
    title: string;
    description: string | null;
    tags_json: string | null;
}

function videoSearchColumn(field: VideoSearchField): string {
    switch (field) {
        case "title":
            return "title";
        case "description":
            return "COALESCE(description, '')";
        case "tags":
            return "COALESCE(tags_json, '')";
    }
}

function escapeLike(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function buildVideoHits(row: VideoSearchRow, fields: VideoSearchField[], loweredQuery: string): VideoSearchHit[] {
    const out: VideoSearchHit[] = [];
    const description = row.description ?? "";
    const tags = parseJsonArray(row.tags_json);

    for (const field of fields) {
        if (field === "title" && row.title.toLowerCase().includes(loweredQuery)) {
            out.push({
                videoId: row.id,
                field,
                snippet: row.title,
                title: row.title,
                channelHandle: row.channel_handle,
            });
            continue;
        }

        if (field === "description" && description.toLowerCase().includes(loweredQuery)) {
            out.push({
                videoId: row.id,
                field,
                snippet: snippetAround(description, loweredQuery),
                title: row.title,
                channelHandle: row.channel_handle,
            });
            continue;
        }

        if (field === "tags") {
            const tagHit = tags.find((tag) => tag.toLowerCase().includes(loweredQuery));

            if (tagHit) {
                out.push({
                    videoId: row.id,
                    field,
                    snippet: tagHit,
                    title: row.title,
                    channelHandle: row.channel_handle,
                });
            }
        }
    }

    return out;
}

function snippetAround(text: string, loweredQuery: string, contextChars = 80): string {
    const lower = text.toLowerCase();
    const index = lower.indexOf(loweredQuery);

    if (index === -1) {
        return text.slice(0, contextChars * 2);
    }

    const start = Math.max(0, index - contextChars);
    const end = Math.min(text.length, index + loweredQuery.length + contextChars);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < text.length ? "…" : "";

    return `${prefix}${text.slice(start, end)}${suffix}`.replace(/\s+/g, " ").trim();
}
