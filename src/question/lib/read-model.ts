import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { parseJsonlChunk } from "@app/utils/jsonl";
import { logDir } from "./log-store";
import type { QaEntry } from "./types";

const log = logger.child({ component: "question:read-model" });

export function openReadModel(dbPath: string): Database {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(`CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY, ts INTEGER, session_id TEXT, session_title TEXT,
        project TEXT, repo_root TEXT, cwd TEXT, branch TEXT, commit_sha TEXT,
        is_worktree INTEGER, worktree_path TEXT, ai_agent TEXT, agent_label TEXT,
        tag TEXT, question TEXT, answer_md TEXT, refs_json TEXT, source TEXT,
        turn_uuid TEXT, superseded_by TEXT, read_at INTEGER,
        dedupe_key TEXT
    );`);
    db.exec("CREATE TABLE IF NOT EXISTS ingest_offsets (file TEXT PRIMARY KEY, byte_offset INTEGER);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_entries_project_ts ON entries(project, ts);");
    return db;
}

function dedupeKey(en: QaEntry): string {
    return `${en.sessionId}|${Math.round(en.ts / 2000)}|${en.question}`;
}

/** Lazily ingest any JSONL bytes newer than the stored offset. No daemon. */
function catchUp(db: Database, logBase?: string): void {
    const dir = logDir(logBase);
    if (!existsSync(dir)) {
        return;
    }

    const insert = db.prepare(`INSERT OR REPLACE INTO entries
        (id,ts,session_id,session_title,project,repo_root,cwd,branch,commit_sha,is_worktree,worktree_path,ai_agent,agent_label,tag,question,answer_md,refs_json,source,turn_uuid,superseded_by,read_at,dedupe_key)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)`);
    const getOff = db.prepare("SELECT byte_offset FROM ingest_offsets WHERE file = ?");
    const setOff = db.prepare("INSERT OR REPLACE INTO ingest_offsets (file, byte_offset) VALUES (?, ?)");
    const supersede = db.prepare(
        "UPDATE entries SET superseded_by = ? WHERE dedupe_key = ? AND id != ? AND superseded_by IS NULL"
    );

    for (const name of readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()) {
        const file = join(dir, name);
        const size = statSync(file).size;
        const prev = (getOff.get(file) as { byte_offset: number } | null)?.byte_offset ?? 0;
        if (size <= prev) {
            continue;
        }

        const buf = readFileSync(file).subarray(prev);
        let entries: QaEntry[];
        let remainder: Buffer;
        try {
            const parsed = parseJsonlChunk<QaEntry>(buf);
            entries = parsed.values;
            remainder = parsed.remainder;
        } catch (err) {
            log.warn({ err, file }, "skipping unparseable JSONL tail");
            continue;
        }

        // Only complete lines were consumed; a partially-written trailing line
        // stays in `remainder` and must be re-read next pass — so advance the
        // offset by the consumed-bytes only, never the full file size (t16).
        const consumed = buf.length - remainder.length;
        const tx = db.transaction((rows: QaEntry[]) => {
            for (const en of rows) {
                const key = dedupeKey(en);
                insert.run(
                    en.id,
                    en.ts,
                    en.sessionId,
                    en.sessionTitle,
                    en.project,
                    en.repoRoot,
                    en.cwd,
                    en.branch,
                    en.commitSha,
                    en.isWorktree ? 1 : 0,
                    en.worktreePath,
                    en.aiAgent,
                    en.agentLabel,
                    en.tag,
                    en.question,
                    en.answerMd,
                    SafeJSON.stringify(en.refs),
                    en.source,
                    en.turnUuid,
                    key
                );
                supersede.run(en.id, key, en.id); // older same-key rows point at the newest
            }
            // Offset write is inside the tx so a crash can't desync it from the
            // inserts — atomic ingest checkpoint (t2).
            setOff.run(file, prev + consumed);
        });
        tx(entries);
    }
}

export interface QueryOpts {
    logBase?: string;
    project?: string;
    tag?: string;
    unread?: boolean;
    limit?: number;
}
export interface QaRow extends QaEntry {
    supersededBy: string | null;
    readAt: number | null;
}

export function queryEntries(db: Database, opts: QueryOpts = {}): QaRow[] {
    catchUp(db, opts.logBase);
    const where: string[] = ["superseded_by IS NULL"];
    const params: (string | number)[] = [];
    if (opts.project) {
        where.push("project = ?");
        params.push(opts.project);
    }

    if (opts.tag) {
        where.push("tag = ?");
        params.push(opts.tag);
    }

    if (opts.unread) {
        where.push("read_at IS NULL");
    }

    const sql = `SELECT * FROM entries WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ?`;
    params.push(opts.limit ?? 50);
    return (db.query(sql).all(...params) as Record<string, unknown>[]).map((r) => ({
        id: r.id as string,
        ts: r.ts as number,
        sessionId: r.session_id as string,
        sessionTitle: r.session_title as string | null,
        project: r.project as string,
        repoRoot: r.repo_root as string,
        cwd: r.cwd as string,
        branch: r.branch as string | null,
        commitSha: r.commit_sha as string | null,
        isWorktree: !!r.is_worktree,
        worktreePath: r.worktree_path as string | null,
        aiAgent: r.ai_agent as string | null,
        agentLabel: r.agent_label as string | null,
        tag: r.tag as QaEntry["tag"],
        question: r.question as string,
        answerMd: r.answer_md as string,
        refs: SafeJSON.parse(r.refs_json as string) as QaEntry["refs"],
        source: r.source as QaEntry["source"],
        turnUuid: r.turn_uuid as string | null,
        supersededBy: r.superseded_by as string | null,
        readAt: r.read_at as number | null,
    }));
}

export function markEntriesUnread(db: Database, ids: string[], opts: Pick<QueryOpts, "logBase"> = {}): number {
    if (ids.length === 0) {
        return 0;
    }

    catchUp(db, opts.logBase);
    const placeholders = ids.map(() => "?").join(",");
    const result = db.run(`UPDATE entries SET read_at = NULL WHERE id IN (${placeholders})`, ids);

    return result.changes;
}

export function markEntriesRead(db: Database, ids: string[], opts: Pick<QueryOpts, "logBase"> = {}): number {
    if (ids.length === 0) {
        return 0;
    }

    catchUp(db, opts.logBase);
    const now = Date.now();
    const stmt = db.prepare("UPDATE entries SET read_at = ? WHERE id = ? AND read_at IS NULL");
    let updated = 0;

    const tx = db.transaction((rowIds: string[]) => {
        for (const id of rowIds) {
            updated += stmt.run(now, id).changes;
        }
    });
    tx(ids);

    return updated;
}
