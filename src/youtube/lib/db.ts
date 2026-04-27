import { homedir } from "node:os";
import { join } from "node:path";
import { BaseDatabase } from "@app/utils/database";

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

    initSchemaForTest(): void {
        this.initSchema();
    }
}
