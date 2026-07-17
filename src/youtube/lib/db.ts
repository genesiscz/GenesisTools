import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@app/logger";
import { BaseDatabase, SQL_NOW_UTC } from "@app/utils/database";
import { SafeJSON } from "@app/utils/json";
import { withFileLock } from "@app/utils/storage";
import { deleteIfExists } from "@app/youtube/lib/cache";
import type { Channel, ChannelHandle } from "@app/youtube/lib/channel.types";
import type { FetchedComment, VideoComment } from "@app/youtube/lib/comments.types";
import type {
    AdminListAiCallsOpts,
    AdminListUsersOpts,
    AdminListWebhookLogsOpts,
    AdminRevenueSummary,
    AdminUserRow,
    AdminUserTotals,
    AiCallRecord,
    AskMessageRecord,
    AskMessageRole,
    AskThreadRecord,
    ClaimJobOpts,
    CollectionKind,
    CollectionRecord,
    CreateCollectionInput,
    EnqueueJobInput,
    GetTranscriptOpts,
    ListJobsOpts,
    ListVideosOpts,
    PaymentKind,
    PaymentRecord,
    PaymentStatus,
    PruneExpiredBinariesOpts,
    PruneExpiredBinariesResult,
    QueueStats,
    RecordAiCallInput,
    RecordJobActivityInput,
    RecordPaymentInput,
    RecordVideoLogInput,
    RecordWebhookLogInput,
    ReferralRecord,
    SaveTranscriptInput,
    SearchTranscriptsOpts,
    SearchVideosOpts,
    SetVideoBinaryPathInput,
    SetVideoSummaryInput,
    SubscriptionRecord,
    TranscriptSearchHit,
    UpdateJobPartial,
    UpdateSubscriptionPartial,
    UpdateUserPrefsInput,
    UpsertChannelInput,
    UpsertQaChunkInput,
    UpsertSubscriptionInput,
    UpsertVideoInput,
    VideoLite,
    VideoLogKind,
    VideoLogRecord,
    VideoSearchField,
    VideoSearchHit,
    VideoWatchRecord,
    WatchlistEntry,
    WebhookLogRecord,
    WebhookOutcome,
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
import type { UserSettings } from "@app/youtube/lib/user-settings";
import type { ArtifactKind, CreditHold, CreditReason, QaHistoryItem, YtUser } from "@app/youtube/lib/users.types";
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

        // Feature 08 (localization): user output-lang + tts-voice prefs, the
        // lang each stored summary/ask was generated in. Summaries live as
        // columns on `videos` (not their own table), so each mode gets its
        // own sibling lang column instead of one shared `lang` column.
        this.runMigration("add-users-output-lang", () => {
            const userCols = this.db.query<{ name: string }, []>("PRAGMA table_info(users)").all() as Array<{
                name: string;
            }>;

            if (!userCols.some((column) => column.name === "output_lang")) {
                this.db.exec("ALTER TABLE users ADD COLUMN output_lang TEXT");
            }

            if (!userCols.some((column) => column.name === "tts_voice")) {
                this.db.exec("ALTER TABLE users ADD COLUMN tts_voice TEXT");
            }

            const videoCols = this.db.query<{ name: string }, []>("PRAGMA table_info(videos)").all() as Array<{
                name: string;
            }>;

            for (const column of ["summary_short_lang", "summary_timestamped_lang", "summary_long_lang"]) {
                if (!videoCols.some((existingColumn) => existingColumn.name === column)) {
                    this.db.exec(`ALTER TABLE videos ADD COLUMN ${column} TEXT NOT NULL DEFAULT 'en'`);
                }
            }

            const qaHistoryCols = this.db.query<{ name: string }, []>("PRAGMA table_info(qa_history)").all() as Array<{
                name: string;
            }>;

            if (!qaHistoryCols.some((column) => column.name === "lang")) {
                this.db.exec("ALTER TABLE qa_history ADD COLUMN lang TEXT NOT NULL DEFAULT 'en'");
            }
        });

        this.runMigration("add-credit-holds", () => {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS credit_holds (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id),
                    amount INTEGER NOT NULL,
                    reason TEXT NOT NULL,
                    context TEXT,
                    status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'committed', 'released')),
                    ledger_id INTEGER NOT NULL REFERENCES credit_ledger(id),
                    created_at TEXT NOT NULL,
                    resolved_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_credit_holds_status ON credit_holds(status);
            `);
        });

        // Audit trail (Phase 1 foundations). Deliberately NO foreign keys:
        // audit rows must survive user/video/job deletion — they are the
        // history, not live state.
        this.runMigration("add-audit-tables", () => {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS video_watchers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER,
                    video_id TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC})
                );
                CREATE INDEX IF NOT EXISTS idx_video_watchers_video ON video_watchers(video_id, id DESC);
                CREATE INDEX IF NOT EXISTS idx_video_watchers_user ON video_watchers(user_id, id DESC);

                CREATE TABLE IF NOT EXISTS video_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    kind TEXT NOT NULL CHECK (kind IN ('summary:view','insights:view','transcript:view','comments:view')),
                    user_id INTEGER,
                    video_id TEXT NOT NULL,
                    meta_json TEXT,
                    created_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC})
                );
                CREATE INDEX IF NOT EXISTS idx_video_logs_video ON video_logs(video_id, id DESC);
                CREATE INDEX IF NOT EXISTS idx_video_logs_user ON video_logs(user_id, id DESC);

                CREATE TABLE IF NOT EXISTS ai_calls (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    provider TEXT NOT NULL,
                    model TEXT NOT NULL,
                    action TEXT NOT NULL,
                    video_id TEXT,
                    user_id INTEGER,
                    input_tokens INTEGER NOT NULL DEFAULT 0,
                    output_tokens INTEGER NOT NULL DEFAULT 0,
                    cost_usd REAL,
                    credits_charged INTEGER,
                    job_id INTEGER,
                    created_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC})
                );
                CREATE INDEX IF NOT EXISTS idx_ai_calls_user ON ai_calls(user_id, id DESC);
                CREATE INDEX IF NOT EXISTS idx_ai_calls_video ON ai_calls(video_id, id DESC);
                CREATE INDEX IF NOT EXISTS idx_ai_calls_job ON ai_calls(job_id);
            `);
        });

        this.runMigration("add-jobs-user", () => {
            const cols = this.db.query<{ name: string }, []>("PRAGMA table_info(jobs)").all() as Array<{
                name: string;
            }>;

            if (!cols.some((column) => column.name === "user_id")) {
                this.db.exec("ALTER TABLE jobs ADD COLUMN user_id INTEGER");
            }
        });

        // User-owned video collections (Phase 3). Manual and dynamic share one
        // table (`kind` + nullable rule); membership rows are only meaningful
        // for kind='manual' — dynamic membership resolves live from rules.
        this.runMigration("add-collections", () => {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS collections (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK (kind IN ('manual','dynamic')),
                    rule_json TEXT,
                    created_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC}),
                    updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC})
                );
                CREATE INDEX IF NOT EXISTS idx_collections_user ON collections(user_id, id DESC);

                CREATE TABLE IF NOT EXISTS collection_videos (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    collection_id INTEGER NOT NULL,
                    video_id TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC}),
                    UNIQUE (collection_id, video_id)
                );
            `);
        });

        // Collection-Ask conversations (Phase 3). Tool calls persist as
        // role='tool' rows so a replay shows WHAT the agent looked at.
        this.runMigration("add-ask-threads", () => {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS ask_threads (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    collection_id INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC}),
                    updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC})
                );
                CREATE INDEX IF NOT EXISTS idx_ask_threads_user ON ask_threads(user_id, updated_at DESC);

                CREATE TABLE IF NOT EXISTS ask_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    thread_id INTEGER NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
                    content TEXT NOT NULL,
                    tool_name TEXT,
                    tool_args_json TEXT,
                    created_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC})
                );
                CREATE INDEX IF NOT EXISTS idx_ask_messages_thread ON ask_messages(thread_id, id ASC);
            `);
        });

        // Per-user channel follows (Phase 3). Distinct from the global
        // `channels` table, which is operator state.
        this.runMigration("add-watchlist", () => {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS channel_watchlist (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    channel_handle TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC}),
                    UNIQUE (user_id, channel_handle)
                );
            `);
        });

        // Billing state + audit (Phase 2). No FKs — billing history must
        // survive user/row deletion, same rationale as add-audit-tables.
        this.runMigration("add-billing-tables", () => {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS subscriptions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL UNIQUE,
                    stripe_customer_id TEXT,
                    stripe_subscription_id TEXT UNIQUE,
                    plan_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    allowance INTEGER NOT NULL,
                    period_start TEXT,
                    period_end TEXT,
                    period_start_balance INTEGER NOT NULL DEFAULT 0,
                    cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC}),
                    updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC})
                );

                CREATE TABLE IF NOT EXISTS payments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER,
                    kind TEXT NOT NULL CHECK (kind IN ('pack','subscription','refund')),
                    stripe_ref TEXT NOT NULL UNIQUE,
                    pack_id TEXT,
                    plan_id TEXT,
                    amount_cents INTEGER,
                    currency TEXT,
                    credits INTEGER,
                    status TEXT NOT NULL CHECK (status IN ('succeeded','failed','refunded')),
                    created_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC})
                );
                CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, id DESC);

                CREATE TABLE IF NOT EXISTS webhook_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    stripe_event_id TEXT NOT NULL UNIQUE,
                    type TEXT NOT NULL,
                    payload_hash TEXT NOT NULL,
                    outcome TEXT NOT NULL CHECK (outcome IN ('processed','skipped','duplicate','error')),
                    detail TEXT,
                    created_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC})
                );

                CREATE TABLE IF NOT EXISTS quota_usage (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    month TEXT NOT NULL,
                    actions INTEGER NOT NULL DEFAULT 0,
                    UNIQUE (user_id, month)
                );
            `);
        });

        this.runMigration("add-referrals", () => {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS referral_codes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL UNIQUE,
                    code TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC})
                );

                CREATE TABLE IF NOT EXISTS referrals (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    code TEXT NOT NULL,
                    referrer_user_id INTEGER NOT NULL,
                    referee_user_id INTEGER NOT NULL UNIQUE,
                    reward INTEGER NOT NULL,
                    offer_from TEXT NOT NULL,
                    offer_to TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC})
                );
                CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_user_id, id DESC);
            `);
        });

        this.runMigration("add-user-settings", () => {
            const userCols = this.db.query<{ name: string }, []>("PRAGMA table_info(users)").all() as Array<{
                name: string;
            }>;

            if (!userCols.some((column) => column.name === "settings")) {
                this.db.exec("ALTER TABLE users ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'");
            }
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
        value: string | TimestampedSummaryEntry[] | VideoLongSummary,
        lang?: string
    ): void;
    setVideoSummary(
        inputOrId: SetVideoSummaryInput | VideoId,
        kind?: "short" | "timestamped" | "long",
        value?: string | TimestampedSummaryEntry[] | VideoLongSummary,
        lang?: string
    ): void {
        const input =
            typeof inputOrId === "string" ? normalizeVideoSummaryInput(inputOrId, kind, value, lang) : inputOrId;
        const column =
            input.kind === "short"
                ? "summary_short"
                : input.kind === "timestamped"
                  ? "summary_timestamped_json"
                  : "summary_long_json";
        const langColumn =
            input.kind === "short"
                ? "summary_short_lang"
                : input.kind === "timestamped"
                  ? "summary_timestamped_lang"
                  : "summary_long_lang";
        const serialized = typeof input.value === "string" ? input.value : SafeJSON.stringify(input.value);

        this.db.run(`UPDATE videos SET ${column} = ?, ${langColumn} = ?, updated_at = ${SQL_NOW_UTC} WHERE id = ?`, [
            serialized,
            input.lang ?? "en",
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
            .query<{ id: number }, [string, string, string, number | null, number | null]>(
                `INSERT INTO jobs (target_kind, target, stages, parent_job_id, user_id, status)
                 VALUES (?, ?, ?, ?, ?, 'pending') RETURNING id`
            )
            .get(
                input.targetKind,
                input.target,
                SafeJSON.stringify(input.stages),
                input.parentJobId ?? null,
                input.userId ?? null
            );

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

        if (opts.userId !== undefined) {
            where.push("user_id = ?");
            params.push(opts.userId);
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

    recordVideoWatch(input: { userId: number | null; videoId: string }): void {
        this.db.run("INSERT INTO video_watchers (user_id, video_id) VALUES (?, ?)", [input.userId, input.videoId]);
    }

    recordVideoLog(input: RecordVideoLogInput): void {
        this.db.run("INSERT INTO video_logs (kind, user_id, video_id, meta_json) VALUES (?, ?, ?, ?)", [
            input.kind,
            input.userId,
            input.videoId,
            input.meta ? SafeJSON.stringify(input.meta, { strict: true }) : null,
        ]);
    }

    recordAiCall(input: RecordAiCallInput): void {
        this.db.run(
            `INSERT INTO ai_calls
                (provider, model, action, video_id, user_id, input_tokens, output_tokens, cost_usd, credits_charged, job_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                input.provider,
                input.model,
                input.action,
                input.videoId ?? null,
                input.userId ?? null,
                input.inputTokens ?? 0,
                input.outputTokens ?? 0,
                input.costUsd ?? null,
                input.creditsCharged ?? null,
                input.jobId ?? null,
            ]
        );
    }

    listVideoWatchers(videoId: string, limit = 100): VideoWatchRecord[] {
        const rows = this.db
            .query<VideoWatcherRow, [string, number]>(
                "SELECT * FROM video_watchers WHERE video_id = ? ORDER BY id DESC LIMIT ?"
            )
            .all(videoId, limit);

        return rows.map((row) => ({
            id: row.id,
            userId: row.user_id,
            videoId: row.video_id,
            createdAt: row.created_at,
        }));
    }

    listVideoLogs(opts: { videoId?: string; userId?: number; limit?: number } = {}): VideoLogRecord[] {
        const where: string[] = [];
        const params: Array<string | number> = [];

        if (opts.videoId) {
            where.push("video_id = ?");
            params.push(opts.videoId);
        }

        if (opts.userId !== undefined) {
            where.push("user_id = ?");
            params.push(opts.userId);
        }

        const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const rows = this.db
            .query<VideoLogRow, [...Array<string | number>, number]>(
                `SELECT * FROM video_logs ${whereClause} ORDER BY id DESC LIMIT ?`
            )
            .all(...params, opts.limit ?? 100);

        return rows.map(rowToVideoLog);
    }

    listAiCalls(opts: { userId?: number; videoId?: string; jobId?: number; limit?: number } = {}): AiCallRecord[] {
        const where: string[] = [];
        const params: Array<string | number> = [];

        if (opts.userId !== undefined) {
            where.push("user_id = ?");
            params.push(opts.userId);
        }

        if (opts.videoId) {
            where.push("video_id = ?");
            params.push(opts.videoId);
        }

        if (opts.jobId !== undefined) {
            where.push("job_id = ?");
            params.push(opts.jobId);
        }

        const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const rows = this.db
            .query<AiCallRow, [...Array<string | number>, number]>(
                `SELECT * FROM ai_calls ${whereClause} ORDER BY id DESC LIMIT ?`
            )
            .all(...params, opts.limit ?? 100);

        return rows.map(rowToAiCall);
    }

    getQueueStats(): QueueStats {
        const pendingRows = this.db
            .query<{ stage: string | null; count: number }, []>(
                `SELECT json_extract(stages, '$[0]') AS stage, COUNT(*) AS count
                 FROM jobs WHERE status = 'pending' GROUP BY stage`
            )
            .all();
        const runningRows = this.db
            .query<{ stage: string | null; count: number }, []>(
                `SELECT COALESCE(current_stage, json_extract(stages, '$[0]')) AS stage, COUNT(*) AS count
                 FROM jobs WHERE status = 'running' GROUP BY stage`
            )
            .all();
        const oldest = this.db
            .query<{ created_at: string }, []>(
                "SELECT created_at FROM jobs WHERE status = 'pending' ORDER BY id ASC LIMIT 1"
            )
            .get();
        const perStage: Record<string, { queued: number; running: number }> = {};
        let queued = 0;
        let running = 0;

        for (const row of pendingRows) {
            const stage = row.stage ?? "unknown";
            perStage[stage] = perStage[stage] ?? { queued: 0, running: 0 };
            perStage[stage].queued += row.count;
            queued += row.count;
        }

        for (const row of runningRows) {
            const stage = row.stage ?? "unknown";
            perStage[stage] = perStage[stage] ?? { queued: 0, running: 0 };
            perStage[stage].running += row.count;
            running += row.count;
        }

        const oldestQueuedAgeSec = oldest
            ? Math.max(0, Math.round((Date.now() - Date.parse(oldest.created_at)) / 1000))
            : null;

        return { queued, running, perStage, oldestQueuedAgeSec };
    }

    upsertSubscription(input: UpsertSubscriptionInput): SubscriptionRecord {
        this.db.run(
            `INSERT INTO subscriptions
                (user_id, stripe_customer_id, stripe_subscription_id, plan_id, status, allowance,
                 period_start, period_end, period_start_balance, cancel_at_period_end, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${SQL_NOW_UTC})
             ON CONFLICT(user_id) DO UPDATE SET
                stripe_customer_id = COALESCE(excluded.stripe_customer_id, subscriptions.stripe_customer_id),
                stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, subscriptions.stripe_subscription_id),
                plan_id = excluded.plan_id,
                status = excluded.status,
                allowance = excluded.allowance,
                period_start = COALESCE(excluded.period_start, subscriptions.period_start),
                period_end = COALESCE(excluded.period_end, subscriptions.period_end),
                period_start_balance = excluded.period_start_balance,
                cancel_at_period_end = excluded.cancel_at_period_end,
                updated_at = ${SQL_NOW_UTC}`,
            [
                input.userId,
                input.stripeCustomerId ?? null,
                input.stripeSubscriptionId ?? null,
                input.planId,
                input.status,
                input.allowance,
                input.periodStart ?? null,
                input.periodEnd ?? null,
                input.periodStartBalance ?? 0,
                input.cancelAtPeriodEnd ? 1 : 0,
            ]
        );
        const row = this.getSubscriptionByUserId(input.userId);

        if (!row) {
            throw new Error(`upsertSubscription: user ${input.userId} row missing after upsert`);
        }

        return row;
    }

    getSubscriptionByUserId(userId: number): SubscriptionRecord | null {
        const row = this.db
            .query<SubscriptionRow, [number]>("SELECT * FROM subscriptions WHERE user_id = ?")
            .get(userId);

        return row ? rowToSubscription(row) : null;
    }

    getSubscriptionByStripeId(stripeSubscriptionId: string): SubscriptionRecord | null {
        const row = this.db
            .query<SubscriptionRow, [string]>("SELECT * FROM subscriptions WHERE stripe_subscription_id = ?")
            .get(stripeSubscriptionId);

        return row ? rowToSubscription(row) : null;
    }

    updateSubscription(id: number, partial: UpdateSubscriptionPartial): void {
        const sets: string[] = [];
        const params: Array<string | number | null> = [];
        const push = (column: string, value: string | number | null): void => {
            sets.push(`${column} = ?`);
            params.push(value);
        };

        if (partial.stripeCustomerId !== undefined) {
            push("stripe_customer_id", partial.stripeCustomerId);
        }

        if (partial.stripeSubscriptionId !== undefined) {
            push("stripe_subscription_id", partial.stripeSubscriptionId);
        }

        if (partial.status !== undefined) {
            push("status", partial.status);
        }

        if (partial.allowance !== undefined) {
            push("allowance", partial.allowance);
        }

        if (partial.periodStart !== undefined) {
            push("period_start", partial.periodStart);
        }

        if (partial.periodEnd !== undefined) {
            push("period_end", partial.periodEnd);
        }

        if (partial.periodStartBalance !== undefined) {
            push("period_start_balance", partial.periodStartBalance);
        }

        if (partial.cancelAtPeriodEnd !== undefined) {
            push("cancel_at_period_end", partial.cancelAtPeriodEnd ? 1 : 0);
        }

        if (sets.length === 0) {
            return;
        }

        sets.push(`updated_at = ${SQL_NOW_UTC}`);
        params.push(id);
        this.db.run(`UPDATE subscriptions SET ${sets.join(", ")} WHERE id = ?`, params);
    }

    /** Replay-safe on `stripe_ref` — a webhook retry inserts nothing new. */
    recordPayment(input: RecordPaymentInput): void {
        this.db.run(
            `INSERT OR IGNORE INTO payments
                (user_id, kind, stripe_ref, pack_id, plan_id, amount_cents, currency, credits, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                input.userId,
                input.kind,
                input.stripeRef,
                input.packId ?? null,
                input.planId ?? null,
                input.amountCents ?? null,
                input.currency ?? null,
                input.credits ?? null,
                input.status,
            ]
        );
    }

    listPayments(opts: { userId?: number; limit?: number } = {}): PaymentRecord[] {
        const where = opts.userId !== undefined ? "WHERE user_id = ?" : "";
        const params: Array<number> = opts.userId !== undefined ? [opts.userId] : [];
        const rows = this.db
            .query<PaymentRow, [...number[], number]>(`SELECT * FROM payments ${where} ORDER BY id DESC LIMIT ?`)
            .all(...params, opts.limit ?? 100);

        return rows.map(rowToPayment);
    }

    getWebhookLog(stripeEventId: string): WebhookLogRecord | null {
        const row = this.db
            .query<WebhookLogRow, [string]>("SELECT * FROM webhook_logs WHERE stripe_event_id = ?")
            .get(stripeEventId);

        return row ? rowToWebhookLog(row) : null;
    }

    recordWebhookLog(input: RecordWebhookLogInput): void {
        this.db.run(
            `INSERT INTO webhook_logs (stripe_event_id, type, payload_hash, outcome, detail)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(stripe_event_id) DO UPDATE SET
                outcome = excluded.outcome,
                detail = excluded.detail`,
            [input.stripeEventId, input.type, input.payloadHash, input.outcome, input.detail ?? null]
        );
    }

    /** Balance lookup by id — the webhook reset math needs it (users are otherwise fetched by token/email). */
    getUserCredits(userId: number): number | null {
        const row = this.db.query<{ credits: number }, [number]>("SELECT credits FROM users WHERE id = ?").get(userId);

        return row?.credits ?? null;
    }

    getUserEmailById(userId: number): string | null {
        const row = this.db.query<{ email: string }, [number]>("SELECT email FROM users WHERE id = ?").get(userId);

        return row?.email ?? null;
    }

    /** SUM of positive grant-type deltas since `sinceIso` — the frozen grant-reason set. */
    getGrantsSince(userId: number, sinceIso: string): number {
        const row = this.db
            .query<{ total: number | null }, [number, string]>(
                `SELECT SUM(delta) AS total FROM credit_ledger
                 WHERE user_id = ? AND created_at >= ? AND delta > 0
                   AND (reason LIKE 'stripe:%' OR reason = 'dev-topup' OR reason LIKE 'referral:%' OR reason = 'register-grant')`
            )
            .get(userId, sinceIso);

        return row?.total ?? 0;
    }

    /** True when the user ever completed a Stripe purchase (quota exemption). */
    hasAnyStripeGrant(userId: number): boolean {
        const row = this.db
            .query<{ found: number }, [number]>(
                "SELECT 1 AS found FROM credit_ledger WHERE user_id = ? AND delta > 0 AND reason LIKE 'stripe:%' LIMIT 1"
            )
            .get(userId);

        return row !== null;
    }

    /** Atomic check-and-increment: never increments past `limit`. */
    incrementQuotaIfBelow(userId: number, month: string, limit: number): { allowed: boolean; used: number } {
        const bump = this.db.transaction(() => {
            const existing = this.db
                .query<{ actions: number }, [number, string]>(
                    "SELECT actions FROM quota_usage WHERE user_id = ? AND month = ?"
                )
                .get(userId, month);
            const used = existing?.actions ?? 0;

            if (used >= limit) {
                return { allowed: false, used };
            }

            this.db.run(
                `INSERT INTO quota_usage (user_id, month, actions) VALUES (?, ?, 1)
                 ON CONFLICT(user_id, month) DO UPDATE SET actions = actions + 1`,
                [userId, month]
            );

            return { allowed: true, used: used + 1 };
        });

        return bump();
    }

    getQuotaUsed(userId: number, month: string): number {
        const row = this.db
            .query<{ actions: number }, [number, string]>(
                "SELECT actions FROM quota_usage WHERE user_id = ? AND month = ?"
            )
            .get(userId, month);

        return row?.actions ?? 0;
    }

    /** Returns the user's existing code, or inserts `code` and returns it. */
    getOrCreateReferralCode(userId: number, code: string): string {
        const claim = this.db.transaction(() => {
            const existing = this.db
                .query<{ code: string }, [number]>("SELECT code FROM referral_codes WHERE user_id = ?")
                .get(userId);

            if (existing) {
                return existing.code;
            }

            this.db.run("INSERT INTO referral_codes (user_id, code) VALUES (?, ?)", [userId, code]);

            return code;
        });

        return claim();
    }

    getReferralCodeOwner(code: string): number | null {
        const row = this.db
            .query<{ user_id: number }, [string]>("SELECT user_id FROM referral_codes WHERE code = ?")
            .get(code);

        return row?.user_id ?? null;
    }

    /** Read-only lookup of a user's existing referral code (never creates one). */
    getReferralCodeForUser(userId: number): string | null {
        const row = this.db
            .query<{ code: string }, [number]>("SELECT code FROM referral_codes WHERE user_id = ?")
            .get(userId);

        return row?.code ?? null;
    }

    createReferral(input: {
        code: string;
        referrerUserId: number;
        refereeUserId: number;
        reward: number;
        offerFrom: string;
        offerTo: string;
    }): number {
        const row = this.db
            .query<{ id: number }, [string, number, number, number, string, string]>(
                `INSERT INTO referrals (code, referrer_user_id, referee_user_id, reward, offer_from, offer_to)
                 VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
            )
            .get(input.code, input.referrerUserId, input.refereeUserId, input.reward, input.offerFrom, input.offerTo);

        if (!row) {
            throw new Error("createReferral: insert returned no id");
        }

        return row.id;
    }

    getReferralByReferee(refereeUserId: number): ReferralRecord | null {
        const row = this.db
            .query<ReferralRow, [number]>("SELECT * FROM referrals WHERE referee_user_id = ?")
            .get(refereeUserId);

        return row ? rowToReferral(row) : null;
    }

    listReferralsByReferrer(referrerUserId: number): ReferralRecord[] {
        const rows = this.db
            .query<ReferralRow, [number]>("SELECT * FROM referrals WHERE referrer_user_id = ? ORDER BY id DESC")
            .all(referrerUserId);

        return rows.map(rowToReferral);
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

    getUserById(userId: number): YtUser | null {
        const row = this.db.query<UserRow, [number]>("SELECT * FROM users WHERE id = ?").get(userId);

        return row ? rowToUser(row) : null;
    }

    /**
     * Admin users table: one row per user with money aggregates joined from
     * pre-aggregated subqueries (one row per user_id each) so payments × ai_calls
     * never multiply. Role is config-derived and attached in the route, not here.
     */
    adminListUsers(opts: AdminListUsersOpts): { rows: AdminUserRow[]; total: number } {
        const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
        const offset = Math.max(opts.offset ?? 0, 0);
        const filters: string[] = [];
        const params: Array<string> = [];

        if (opts.search) {
            filters.push("u.email LIKE ?");
            params.push(`%${opts.search}%`);
        }

        if (opts.subscription === "none") {
            filters.push("s.status IS NULL");
        } else if (opts.subscription) {
            filters.push("s.status = ?");
            params.push(opts.subscription);
        }

        const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
        const orderCol = ADMIN_USER_SORTS[opts.sort ?? "created"] ?? ADMIN_USER_SORTS.created;
        const dir = opts.dir === "asc" ? "ASC" : "DESC";
        const base = `
            FROM users u
            LEFT JOIN (SELECT user_id, SUM(amount_cents) AS revenue_cents FROM payments WHERE status = 'succeeded' GROUP BY user_id) p ON p.user_id = u.id
            LEFT JOIN (SELECT user_id, SUM(cost_usd) AS cost_usd FROM ai_calls GROUP BY user_id) a ON a.user_id = u.id
            LEFT JOIN subscriptions s ON s.user_id = u.id
            ${where}`;
        const total = this.db.query<{ n: number }, string[]>(`SELECT COUNT(*) AS n ${base}`).get(...params)?.n ?? 0;
        const rows = this.db
            .query<AdminUserRowRaw, [...string[], number, number]>(
                `SELECT u.id, u.email, u.credits, u.created_at, u.last_login_at,
                        COALESCE(p.revenue_cents, 0) AS revenue_cents,
                        COALESCE(a.cost_usd, 0) AS cost_usd,
                        s.status AS sub_status, s.plan_id AS sub_plan_id
                 ${base}
                 ORDER BY ${orderCol} ${dir}, u.id DESC
                 LIMIT ? OFFSET ?`
            )
            .all(...params, limit, offset);

        return { rows: rows.map(rowToAdminUser), total };
    }

    /** Money aggregates + row counts for one user's admin profile header. */
    adminUserTotals(userId: number): AdminUserTotals {
        const row = this.db
            .query<
                { revenue_cents: number; cost_usd: number; payments_count: number; ai_calls_count: number },
                [number, number, number, number]
            >(
                `SELECT
                    (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE user_id = ? AND status = 'succeeded') AS revenue_cents,
                    (SELECT COALESCE(SUM(cost_usd), 0) FROM ai_calls WHERE user_id = ?) AS cost_usd,
                    (SELECT COUNT(*) FROM payments WHERE user_id = ?) AS payments_count,
                    (SELECT COUNT(*) FROM ai_calls WHERE user_id = ?) AS ai_calls_count`
            )
            .get(userId, userId, userId, userId);

        return {
            revenueCents: row?.revenue_cents ?? 0,
            aiCostUsd: row?.cost_usd ?? 0,
            paymentsCount: row?.payments_count ?? 0,
            aiCallsCount: row?.ai_calls_count ?? 0,
        };
    }

    /** Paginated ai_calls for the admin ops view, filterable by provider/action/user. Newest first. */
    adminListAiCalls(opts: AdminListAiCallsOpts = {}): { rows: AiCallRecord[]; total: number } {
        const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
        const offset = Math.max(opts.offset ?? 0, 0);
        const where: string[] = [];
        const params: Array<string | number> = [];

        if (opts.provider) {
            where.push("provider = ?");
            params.push(opts.provider);
        }

        if (opts.action) {
            where.push("action = ?");
            params.push(opts.action);
        }

        if (opts.userId !== undefined) {
            where.push("user_id = ?");
            params.push(opts.userId);
        }

        const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const total =
            this.db
                .query<{ n: number }, Array<string | number>>(`SELECT COUNT(*) AS n FROM ai_calls ${whereClause}`)
                .get(...params)?.n ?? 0;
        const rows = this.db
            .query<AiCallRow, [...Array<string | number>, number, number]>(
                `SELECT * FROM ai_calls ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`
            )
            .all(...params, limit, offset);

        return { rows: rows.map(rowToAiCall), total };
    }

    /** Paginated webhook_logs for the admin ops view, filterable by outcome. Newest first. */
    adminListWebhookLogs(opts: AdminListWebhookLogsOpts = {}): { rows: WebhookLogRecord[]; total: number } {
        const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
        const offset = Math.max(opts.offset ?? 0, 0);
        const whereClause = opts.outcome ? "WHERE outcome = ?" : "";
        const params: string[] = opts.outcome ? [opts.outcome] : [];
        const total =
            this.db
                .query<{ n: number }, string[]>(`SELECT COUNT(*) AS n FROM webhook_logs ${whereClause}`)
                .get(...params)?.n ?? 0;
        const rows = this.db
            .query<WebhookLogRow, [...string[], number, number]>(
                `SELECT * FROM webhook_logs ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`
            )
            .all(...params, limit, offset);

        return { rows: rows.map(rowToWebhookLog), total };
    }

    /** Paginated jobs list for the admin ops view (reuses listJobs), plus the matching total. */
    adminListJobs(opts: { status?: JobStatus; limit?: number; offset?: number } = {}): {
        rows: PipelineJob[];
        total: number;
    } {
        const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
        const offset = Math.max(opts.offset ?? 0, 0);
        const whereClause = opts.status ? "WHERE status = ?" : "";
        const params: string[] = opts.status ? [opts.status] : [];
        const total =
            this.db.query<{ n: number }, string[]>(`SELECT COUNT(*) AS n FROM jobs ${whereClause}`).get(...params)?.n ??
            0;
        const rows = this.listJobs({ status: opts.status, limit, offset });

        return { rows, total };
    }

    /**
     * Platform revenue summary: lifetime totals plus per-day revenue/AI-cost
     * buckets over the last `days` (zero-filled, oldest→newest, UTC day keys).
     */
    adminRevenueSummary(opts: { days?: number } = {}): AdminRevenueSummary {
        const days = Math.min(Math.max(opts.days ?? 30, 1), 365);
        const totalsRow = this.db
            .query<
                {
                    revenue_cents: number;
                    cost_usd: number;
                    payments_count: number;
                    refunds_count: number;
                    active_subscriptions: number;
                },
                []
            >(
                `SELECT
                    (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE status = 'succeeded') AS revenue_cents,
                    (SELECT COALESCE(SUM(cost_usd), 0) FROM ai_calls) AS cost_usd,
                    (SELECT COUNT(*) FROM payments WHERE status = 'succeeded') AS payments_count,
                    (SELECT COUNT(*) FROM payments WHERE status = 'refunded') AS refunds_count,
                    (SELECT COUNT(*) FROM subscriptions WHERE status = 'active') AS active_subscriptions`
            )
            .get();

        const now = Date.now();
        const cutoff = new Date(now - (days - 1) * 86_400_000).toISOString().slice(0, 10);
        const revenueByDay = new Map<string, number>();

        for (const row of this.db
            .query<{ day: string; revenue_cents: number }, [string]>(
                `SELECT substr(created_at, 1, 10) AS day, COALESCE(SUM(amount_cents), 0) AS revenue_cents
                 FROM payments WHERE status = 'succeeded' AND substr(created_at, 1, 10) >= ? GROUP BY day`
            )
            .all(cutoff)) {
            revenueByDay.set(row.day, row.revenue_cents);
        }

        const costByDay = new Map<string, number>();

        for (const row of this.db
            .query<{ day: string; cost_usd: number }, [string]>(
                `SELECT substr(created_at, 1, 10) AS day, COALESCE(SUM(cost_usd), 0) AS cost_usd
                 FROM ai_calls WHERE substr(created_at, 1, 10) >= ? GROUP BY day`
            )
            .all(cutoff)) {
            costByDay.set(row.day, row.cost_usd);
        }

        const daily: AdminRevenueSummary["daily"] = [];

        for (let i = days - 1; i >= 0; i--) {
            const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
            daily.push({ day, revenueCents: revenueByDay.get(day) ?? 0, aiCostUsd: costByDay.get(day) ?? 0 });
        }

        return {
            totals: {
                revenueCents: totalsRow?.revenue_cents ?? 0,
                aiCostUsd: totalsRow?.cost_usd ?? 0,
                paymentsCount: totalsRow?.payments_count ?? 0,
                refundsCount: totalsRow?.refunds_count ?? 0,
                activeSubscriptions: totalsRow?.active_subscriptions ?? 0,
            },
            daily,
        };
    }

    touchUserLogin(id: number): void {
        this.db.run(`UPDATE users SET last_login_at = ${SQL_NOW_UTC} WHERE id = ?`, [id]);
    }

    /** Partial update of user preferences (Feature 08 output lang, Feature 12 TTS voice). Undefined fields are left untouched. */
    updateUserPrefs(userId: number, patch: UpdateUserPrefsInput): YtUser {
        const sets: string[] = [];
        const params: Array<string | null> = [];

        if (patch.outputLang !== undefined) {
            sets.push("output_lang = ?");
            params.push(patch.outputLang);
        }

        if (patch.ttsVoice !== undefined) {
            sets.push("tts_voice = ?");
            params.push(patch.ttsVoice);
        }

        if (sets.length === 0) {
            const current = this.db.query<UserRow, [number]>("SELECT * FROM users WHERE id = ?").get(userId);

            if (!current) {
                throw new Error(`updateUserPrefs: user ${userId} not found`);
            }

            return rowToUser(current);
        }

        const row = this.db
            .query<UserRow, Array<string | number | null>>(
                `UPDATE users SET ${sets.join(", ")} WHERE id = ? RETURNING *`
            )
            .get(...params, userId);

        if (!row) {
            throw new Error(`updateUserPrefs: user ${userId} not found`);
        }

        return rowToUser(row);
    }

    /** Persist the full (already-merged + validated) customization settings blob for a user. */
    updateUserSettings(userId: number, settings: UserSettings): YtUser {
        const row = this.db
            .query<UserRow, [string, number]>("UPDATE users SET settings = ? WHERE id = ? RETURNING *")
            .get(SafeJSON.stringify(settings), userId);

        if (!row) {
            throw new Error(`updateUserSettings: user ${userId} not found`);
        }

        return rowToUser(row);
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

    private writeCreditLedger(userId: number, delta: number, reason: CreditReason, balanceAfter: number): number {
        const row = this.db
            .query<{ id: number }, [number, number, string, number]>(
                `INSERT INTO credit_ledger (user_id, delta, reason, balance_after, created_at)
                 VALUES (?, ?, ?, ?, ${SQL_NOW_UTC}) RETURNING id`
            )
            .get(userId, delta, reason, balanceAfter);

        if (!row) {
            throw new Error("writeCreditLedger: insert returned no row");
        }

        return row.id;
    }

    /**
     * Atomically reserves credits for in-flight external work (LLM/TTS). The
     * balance is decremented immediately — same conditional UPDATE as
     * `spendCredits`, throws `InsufficientCreditsError` — and the reservation
     * is visible as a `hold:<reason>` ledger row plus a `credit_holds` row.
     * Resolve with `commitHold` (success) or `releaseHold` (refund).
     */
    reserveCredits(input: { userId: number; amount: number; reason: CreditReason; context?: string }): {
        holdId: number;
        credits: number;
    } {
        const reserve = this.db.transaction(() => {
            const row = this.db
                .query<{ credits: number }, [number, number, number]>(
                    "UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ? RETURNING credits"
                )
                .get(input.amount, input.userId, input.amount);

            if (!row) {
                const current = this.db
                    .query<{ credits: number }, [number]>("SELECT credits FROM users WHERE id = ?")
                    .get(input.userId);
                throw new InsufficientCreditsError(current?.credits ?? 0, input.amount);
            }

            const holdReason: CreditReason = input.context
                ? `hold:${input.reason}:${input.context}`
                : `hold:${input.reason}`;
            const ledgerId = this.writeCreditLedger(input.userId, -input.amount, holdReason, row.credits);
            const hold = this.db
                .query<{ id: number }, [number, number, string, string | null, number]>(
                    `INSERT INTO credit_holds (user_id, amount, reason, context, ledger_id, created_at)
                     VALUES (?, ?, ?, ?, ?, ${SQL_NOW_UTC}) RETURNING id`
                )
                .get(input.userId, input.amount, input.reason, input.context ?? null, ledgerId);

            if (!hold) {
                throw new Error("reserveCredits: hold insert returned no row");
            }

            return { holdId: hold.id, credits: row.credits };
        });

        return reserve();
    }

    /**
     * Finalizes a hold after the work succeeded: the money stays spent and the
     * hold's ledger row is rewritten from `hold:<reason>...` to the bare final
     * reason, so a completed spend is indistinguishable from a direct
     * `spendCredits` (usage summaries keep grouping by the real reason).
     */
    commitHold(holdId: number): void {
        const commit = this.db.transaction(() => {
            const hold = this.getCreditHoldRow(holdId);

            if (hold?.status !== "held") {
                throw new Error(`commitHold: hold ${holdId} is ${hold?.status ?? "missing"}, expected "held"`);
            }

            this.db.run(`UPDATE credit_holds SET status = 'committed', resolved_at = ${SQL_NOW_UTC} WHERE id = ?`, [
                holdId,
            ]);
            this.db.run("UPDATE credit_ledger SET reason = ? WHERE id = ?", [hold.reason, hold.ledger_id]);
        });

        commit();
    }

    /**
     * Refunds a hold (work failed, lost a synthesis race, or orphaned by a
     * crash): the amount is credited back with a `hold-release:` ledger row.
     * Returns the new balance.
     */
    releaseHold(holdId: number): number {
        const release = this.db.transaction(() => {
            const hold = this.getCreditHoldRow(holdId);

            if (hold?.status !== "held") {
                throw new Error(`releaseHold: hold ${holdId} is ${hold?.status ?? "missing"}, expected "held"`);
            }

            this.db.run(`UPDATE credit_holds SET status = 'released', resolved_at = ${SQL_NOW_UTC} WHERE id = ?`, [
                holdId,
            ]);
            const row = this.db
                .query<{ credits: number }, [number, number]>(
                    "UPDATE users SET credits = credits + ? WHERE id = ? RETURNING credits"
                )
                .get(hold.amount, hold.user_id);

            if (!row) {
                throw new Error(`releaseHold: user ${hold.user_id} not found`);
            }

            const releaseReason: CreditReason = hold.context
                ? `hold-release:${hold.reason}:${hold.context}`
                : `hold-release:${hold.reason}`;
            this.writeCreditLedger(hold.user_id, hold.amount, releaseReason, row.credits);
            return row.credits;
        });

        return release();
    }

    /**
     * Boot-time crash recovery: a hold still `held` when the server starts
     * belonged to a request of a previous process and can never be resolved —
     * release (refund) them all. Must only run while no requests are in
     * flight (i.e. at server startup). Returns the number released.
     */
    releaseStaleHolds(): number {
        const rows = this.db.query<{ id: number }, []>("SELECT id FROM credit_holds WHERE status = 'held'").all();

        for (const row of rows) {
            this.releaseHold(row.id);
        }

        return rows.length;
    }

    getCreditHold(holdId: number): CreditHold | null {
        const row = this.getCreditHoldRow(holdId);

        if (!row) {
            return null;
        }

        return {
            id: row.id,
            userId: row.user_id,
            amount: row.amount,
            reason: row.reason,
            context: row.context,
            status: row.status,
            createdAt: row.created_at,
            resolvedAt: row.resolved_at,
        };
    }

    private getCreditHoldRow(holdId: number): CreditHoldRow | null {
        return this.db.query<CreditHoldRow, [number]>("SELECT * FROM credit_holds WHERE id = ?").get(holdId);
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
        lang?: string;
    }): QaHistoryItem {
        const scopeJson = input.scope
            ? SafeJSON.stringify({ scope: input.scope, candidateVideoIds: input.candidateVideoIds })
            : null;
        const row = this.db
            .query<
                QaHistoryRow,
                [number, string, string, string, string, number, string | null, string | null, string]
            >(
                `INSERT INTO qa_history (user_id, video_id, question, answer, citations_json, credits_spent, sources_json, scope_json, lang, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${SQL_NOW_UTC}) RETURNING *`
            )
            .get(
                input.userId,
                input.videoId,
                input.question,
                input.answer,
                SafeJSON.stringify(input.citations),
                input.creditsSpent,
                input.sources ? SafeJSON.stringify(input.sources) : null,
                scopeJson,
                input.lang ?? "en"
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

    createCollection(input: CreateCollectionInput): CollectionRecord {
        const row = this.db
            .query<CollectionRow, [number, string, string, string | null]>(
                `INSERT INTO collections (user_id, name, kind, rule_json)
                 VALUES (?, ?, ?, ?) RETURNING *`
            )
            .get(input.userId, input.name, input.kind, input.ruleJson ?? null);

        if (!row) {
            throw new Error("createCollection: insert returned no row");
        }

        return rowToCollection(row);
    }

    getCollection(userId: number, id: number): CollectionRecord | null {
        const row = this.db
            .query<CollectionRow, [number, number]>("SELECT * FROM collections WHERE id = ? AND user_id = ?")
            .get(id, userId);

        return row ? rowToCollection(row) : null;
    }

    listCollections(userId: number): CollectionRecord[] {
        const rows = this.db
            .query<CollectionRow, [number]>("SELECT * FROM collections WHERE user_id = ? ORDER BY id DESC")
            .all(userId);

        return rows.map(rowToCollection);
    }

    updateCollectionName(userId: number, id: number, name: string): CollectionRecord | null {
        const row = this.db
            .query<CollectionRow, [string, number, number]>(
                `UPDATE collections SET name = ?, updated_at = ${SQL_NOW_UTC}
                 WHERE id = ? AND user_id = ? RETURNING *`
            )
            .get(name, id, userId);

        return row ? rowToCollection(row) : null;
    }

    deleteCollection(userId: number, id: number): boolean {
        const removed = this.db.transaction(() => {
            const result = this.db.run("DELETE FROM collections WHERE id = ? AND user_id = ?", [id, userId]);

            if (result.changes > 0) {
                this.db.run("DELETE FROM collection_videos WHERE collection_id = ?", [id]);
            }

            return result.changes > 0;
        });

        return removed();
    }

    addCollectionVideo(collectionId: number, videoId: string): void {
        this.db.run("INSERT OR IGNORE INTO collection_videos (collection_id, video_id) VALUES (?, ?)", [
            collectionId,
            videoId,
        ]);
    }

    removeCollectionVideo(collectionId: number, videoId: string): boolean {
        const result = this.db.run("DELETE FROM collection_videos WHERE collection_id = ? AND video_id = ?", [
            collectionId,
            videoId,
        ]);

        return result.changes > 0;
    }

    listCollectionVideoIds(collectionId: number): string[] {
        const rows = this.db
            .query<{ video_id: string }, [number]>(
                "SELECT video_id FROM collection_videos WHERE collection_id = ? ORDER BY id ASC"
            )
            .all(collectionId);

        return rows.map((row) => row.video_id);
    }

    createAskThread(input: { userId: number; collectionId: number; title: string }): AskThreadRecord {
        const row = this.db
            .query<AskThreadRow, [number, number, string]>(
                "INSERT INTO ask_threads (user_id, collection_id, title) VALUES (?, ?, ?) RETURNING *"
            )
            .get(input.userId, input.collectionId, input.title);

        if (!row) {
            throw new Error("createAskThread: insert returned no row");
        }

        return rowToAskThread(row);
    }

    getAskThread(userId: number, id: number): AskThreadRecord | null {
        const row = this.db
            .query<AskThreadRow, [number, number]>("SELECT * FROM ask_threads WHERE id = ? AND user_id = ?")
            .get(id, userId);

        return row ? rowToAskThread(row) : null;
    }

    listAskThreads(userId: number, collectionId?: number): AskThreadRecord[] {
        const rows =
            collectionId !== undefined
                ? this.db
                      .query<AskThreadRow, [number, number]>(
                          "SELECT * FROM ask_threads WHERE user_id = ? AND collection_id = ? ORDER BY updated_at DESC, id DESC"
                      )
                      .all(userId, collectionId)
                : this.db
                      .query<AskThreadRow, [number]>(
                          "SELECT * FROM ask_threads WHERE user_id = ? ORDER BY updated_at DESC, id DESC"
                      )
                      .all(userId);

        return rows.map(rowToAskThread);
    }

    appendAskMessage(input: {
        threadId: number;
        role: AskMessageRole;
        content: string;
        toolName?: string | null;
        toolArgsJson?: string | null;
    }): AskMessageRecord {
        const row = this.db
            .query<AskMessageRow, [number, string, string, string | null, string | null]>(
                `INSERT INTO ask_messages (thread_id, role, content, tool_name, tool_args_json)
                 VALUES (?, ?, ?, ?, ?) RETURNING *`
            )
            .get(input.threadId, input.role, input.content, input.toolName ?? null, input.toolArgsJson ?? null);

        if (!row) {
            throw new Error("appendAskMessage: insert returned no row");
        }

        return rowToAskMessage(row);
    }

    listAskMessages(threadId: number): AskMessageRecord[] {
        const rows = this.db
            .query<AskMessageRow, [number]>("SELECT * FROM ask_messages WHERE thread_id = ? ORDER BY id ASC")
            .all(threadId);

        return rows.map(rowToAskMessage);
    }

    touchAskThread(id: number): void {
        this.db.run(`UPDATE ask_threads SET updated_at = ${SQL_NOW_UTC} WHERE id = ?`, [id]);
    }

    addWatchlistChannel(userId: number, channelHandle: string): void {
        this.db.run("INSERT OR IGNORE INTO channel_watchlist (user_id, channel_handle) VALUES (?, ?)", [
            userId,
            channelHandle,
        ]);
    }

    removeWatchlistChannel(userId: number, channelHandle: string): boolean {
        const result = this.db.run("DELETE FROM channel_watchlist WHERE user_id = ? AND channel_handle = ?", [
            userId,
            channelHandle,
        ]);

        return result.changes > 0;
    }

    listWatchlist(userId: number): WatchlistEntry[] {
        const rows = this.db
            .query<{ id: number; user_id: number; channel_handle: string; created_at: string }, [number]>(
                "SELECT * FROM channel_watchlist WHERE user_id = ? ORDER BY id ASC"
            )
            .all(userId);

        return rows.map((row) => ({
            id: row.id,
            userId: row.user_id,
            channelHandle: row.channel_handle,
            createdAt: row.created_at,
        }));
    }

    /** Server-side gate for the collection-ask transcript tool. */
    hasWatched(userId: number, videoId: string): boolean {
        const row = this.db
            .query<{ found: number }, [number, string]>(
                "SELECT 1 AS found FROM video_watchers WHERE user_id = ? AND video_id = ? LIMIT 1"
            )
            .get(userId, videoId);

        return row !== null;
    }

    /** Distinct watched video ids since `sinceIso`, most recently watched first. */
    listWatchedVideoIdsSince(userId: number, sinceIso: string): string[] {
        const rows = this.db
            .query<{ video_id: string }, [number, string]>(
                `SELECT video_id, MAX(id) AS last_id FROM video_watchers
                 WHERE user_id = ? AND created_at >= ?
                 GROUP BY video_id ORDER BY last_id DESC`
            )
            .all(userId, sinceIso);

        return rows.map((row) => row.video_id);
    }

    listWatchesByUser(userId: number, limit = 200): VideoWatchRecord[] {
        const rows = this.db
            .query<VideoWatcherRow, [number, number]>(
                "SELECT * FROM video_watchers WHERE user_id = ? ORDER BY id DESC LIMIT ?"
            )
            .all(userId, limit);

        return rows.map((row) => ({
            id: row.id,
            userId: row.user_id,
            videoId: row.video_id,
            createdAt: row.created_at,
        }));
    }

    getVideosByIds(ids: string[]): VideoLite[] {
        if (ids.length === 0) {
            return [];
        }

        const placeholders = ids.map(() => "?").join(",");
        const rows = this.db
            .query<VideoLiteRow, string[]>(
                `SELECT v.id, v.title, v.channel_handle, v.thumb_url, v.upload_date, v.duration_sec,
                        (v.summary_short IS NOT NULL OR v.summary_timestamped_json IS NOT NULL OR v.summary_long_json IS NOT NULL) AS has_summary,
                        EXISTS (SELECT 1 FROM transcripts t WHERE t.video_id = v.id) AS has_transcript
                 FROM videos v WHERE v.id IN (${placeholders})`
            )
            .all(...ids);

        return rows.map((row) => ({
            id: row.id,
            title: row.title,
            channelHandle: row.channel_handle,
            thumbUrl: row.thumb_url,
            uploadDate: row.upload_date,
            durationSec: row.duration_sec,
            hasSummary: row.has_summary === 1,
            hasTranscript: row.has_transcript === 1,
        }));
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

interface CreditHoldRow {
    id: number;
    user_id: number;
    amount: number;
    reason: CreditReason;
    context: string | null;
    status: CreditHold["status"];
    ledger_id: number;
    created_at: string;
    resolved_at: string | null;
}

interface UserRow {
    id: number;
    email: string;
    password_hash: string;
    api_token: string;
    credits: number;
    created_at: string;
    last_login_at: string | null;
    output_lang: string | null;
    tts_voice: string | null;
    settings: string | null;
}

function rowToUser(row: UserRow): YtUser {
    return {
        id: row.id,
        email: row.email,
        credits: row.credits,
        createdAt: row.created_at,
        outputLang: row.output_lang,
        ttsVoice: row.tts_voice,
        settings: parseUserSettings(row.settings),
    };
}

/** Parse the stored settings JSON; a corrupt/absent value degrades to `{}` rather than throwing. */
function parseUserSettings(raw: string | null): UserSettings {
    if (!raw) {
        return {};
    }

    try {
        const parsed = SafeJSON.parse(raw);

        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as UserSettings;
        }
    } catch (err) {
        logger.debug({ err }, "youtube db: failed to parse user settings JSON");
    }

    return {};
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
    lang: string;
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
        lang: row.lang,
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
    summary_short_lang: string;
    summary_timestamped_lang: string;
    summary_long_lang: string;
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
        summaryShortLang: row.summary_short_lang,
        summaryTimestampedLang: row.summary_timestamped_lang,
        summaryLongLang: row.summary_long_lang,
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
    value: string | TimestampedSummaryEntry[] | VideoLongSummary | undefined,
    lang?: string
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
        lang,
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

interface VideoWatcherRow {
    id: number;
    user_id: number | null;
    video_id: string;
    created_at: string;
}

interface VideoLogRow {
    id: number;
    kind: VideoLogKind;
    user_id: number | null;
    video_id: string;
    meta_json: string | null;
    created_at: string;
}

interface AiCallRow {
    id: number;
    provider: string;
    model: string;
    action: string;
    video_id: string | null;
    user_id: number | null;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number | null;
    credits_charged: number | null;
    job_id: number | null;
    created_at: string;
}

function rowToVideoLog(row: VideoLogRow): VideoLogRecord {
    return {
        id: row.id,
        kind: row.kind,
        userId: row.user_id,
        videoId: row.video_id,
        meta: row.meta_json ? (SafeJSON.parse(row.meta_json) as Record<string, unknown>) : null,
        createdAt: row.created_at,
    };
}

function rowToAiCall(row: AiCallRow): AiCallRecord {
    return {
        id: row.id,
        provider: row.provider,
        model: row.model,
        action: row.action,
        videoId: row.video_id,
        userId: row.user_id,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        costUsd: row.cost_usd,
        creditsCharged: row.credits_charged,
        jobId: row.job_id,
        createdAt: row.created_at,
    };
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
    user_id: number | null;
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
        userId: row.user_id ?? null,
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
        value === "qa" ||
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

interface CollectionRow {
    id: number;
    user_id: number;
    name: string;
    kind: CollectionKind;
    rule_json: string | null;
    created_at: string;
    updated_at: string;
}

function rowToCollection(row: CollectionRow): CollectionRecord {
    return {
        id: row.id,
        userId: row.user_id,
        name: row.name,
        kind: row.kind,
        ruleJson: row.rule_json,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

interface AskThreadRow {
    id: number;
    user_id: number;
    collection_id: number;
    title: string;
    created_at: string;
    updated_at: string;
}

function rowToAskThread(row: AskThreadRow): AskThreadRecord {
    return {
        id: row.id,
        userId: row.user_id,
        collectionId: row.collection_id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

interface AskMessageRow {
    id: number;
    thread_id: number;
    role: AskMessageRole;
    content: string;
    tool_name: string | null;
    tool_args_json: string | null;
    created_at: string;
}

interface VideoLiteRow {
    id: string;
    title: string;
    channel_handle: string;
    thumb_url: string | null;
    upload_date: string | null;
    duration_sec: number | null;
    has_summary: number;
    has_transcript: number;
}

function rowToAskMessage(row: AskMessageRow): AskMessageRecord {
    return {
        id: row.id,
        threadId: row.thread_id,
        role: row.role,
        content: row.content,
        toolName: row.tool_name,
        toolArgsJson: row.tool_args_json,
        createdAt: row.created_at,
    };
}

interface SubscriptionRow {
    id: number;
    user_id: number;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    plan_id: string;
    status: string;
    allowance: number;
    period_start: string | null;
    period_end: string | null;
    period_start_balance: number;
    cancel_at_period_end: number;
    created_at: string;
    updated_at: string;
}

interface PaymentRow {
    id: number;
    user_id: number | null;
    kind: PaymentKind;
    stripe_ref: string;
    pack_id: string | null;
    plan_id: string | null;
    amount_cents: number | null;
    currency: string | null;
    credits: number | null;
    status: PaymentStatus;
    created_at: string;
}

interface WebhookLogRow {
    id: number;
    stripe_event_id: string;
    type: string;
    payload_hash: string;
    outcome: WebhookOutcome;
    detail: string | null;
    created_at: string;
}

function rowToSubscription(row: SubscriptionRow): SubscriptionRecord {
    return {
        id: row.id,
        userId: row.user_id,
        stripeCustomerId: row.stripe_customer_id,
        stripeSubscriptionId: row.stripe_subscription_id,
        planId: row.plan_id,
        status: row.status,
        allowance: row.allowance,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        periodStartBalance: row.period_start_balance,
        cancelAtPeriodEnd: row.cancel_at_period_end === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function rowToPayment(row: PaymentRow): PaymentRecord {
    return {
        id: row.id,
        userId: row.user_id,
        kind: row.kind,
        stripeRef: row.stripe_ref,
        packId: row.pack_id,
        planId: row.plan_id,
        amountCents: row.amount_cents,
        currency: row.currency,
        credits: row.credits,
        status: row.status,
        createdAt: row.created_at,
    };
}

function rowToWebhookLog(row: WebhookLogRow): WebhookLogRecord {
    return {
        id: row.id,
        stripeEventId: row.stripe_event_id,
        type: row.type,
        payloadHash: row.payload_hash,
        outcome: row.outcome,
        detail: row.detail,
        createdAt: row.created_at,
    };
}

interface ReferralRow {
    id: number;
    code: string;
    referrer_user_id: number;
    referee_user_id: number;
    reward: number;
    offer_from: string;
    offer_to: string;
    created_at: string;
}

/** Fixed sort whitelist — never interpolate a raw sort key into SQL. */
const ADMIN_USER_SORTS = {
    created: "u.created_at",
    revenue: "COALESCE(p.revenue_cents, 0)",
    net: "(COALESCE(p.revenue_cents, 0) / 100.0 - COALESCE(a.cost_usd, 0))",
    credits: "u.credits",
} as const;

interface AdminUserRowRaw {
    id: number;
    email: string;
    credits: number;
    created_at: string;
    last_login_at: string | null;
    revenue_cents: number;
    cost_usd: number;
    sub_status: string | null;
    sub_plan_id: string | null;
}

function rowToAdminUser(row: AdminUserRowRaw): AdminUserRow {
    return {
        id: row.id,
        email: row.email,
        credits: row.credits,
        revenueCents: row.revenue_cents,
        aiCostUsd: row.cost_usd,
        subStatus: row.sub_status,
        subPlanId: row.sub_plan_id,
        createdAt: row.created_at,
        lastLoginAt: row.last_login_at,
    };
}

function rowToReferral(row: ReferralRow): ReferralRecord {
    return {
        id: row.id,
        code: row.code,
        referrerUserId: row.referrer_user_id,
        refereeUserId: row.referee_user_id,
        reward: row.reward,
        offerFrom: row.offer_from,
        offerTo: row.offer_to,
        createdAt: row.created_at,
    };
}
