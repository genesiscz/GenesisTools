import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import logger from "@app/logger";

const DB_PATH = join(homedir(), ".genesis-tools", "automate", "automate.db");
const SCHEMA_VERSION = 1;

export class AutomateDatabase {
    private db: Database;

    constructor(dbPath: string = DB_PATH) {
        const dir = dirname(dbPath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        this.db = new Database(dbPath);
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA foreign_keys = ON");
        this.initSchema();
    }

    private initSchema(): void {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL
      );
    `);

        const row = this.db.query("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | null;
        if (!row || row.version < SCHEMA_VERSION) {
            this.db.exec(`
        CREATE TABLE IF NOT EXISTS schedules (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          name        TEXT NOT NULL UNIQUE,
          preset_name TEXT NOT NULL,
          interval    TEXT NOT NULL,
          enabled     INTEGER NOT NULL DEFAULT 1,
          last_run_at TEXT,
          next_run_at TEXT NOT NULL,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
          vars_json   TEXT
        );

        CREATE TABLE IF NOT EXISTS runs (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          schedule_id  INTEGER,
          preset_name  TEXT NOT NULL,
          trigger_type TEXT NOT NULL DEFAULT 'manual',
          started_at   TEXT NOT NULL,
          finished_at  TEXT,
          status       TEXT NOT NULL DEFAULT 'running',
          step_count   INTEGER NOT NULL DEFAULT 0,
          duration_ms  INTEGER,
          error        TEXT,
          FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS run_logs (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id      INTEGER NOT NULL,
          step_index  INTEGER NOT NULL,
          step_id     TEXT NOT NULL,
          step_name   TEXT NOT NULL,
          action      TEXT NOT NULL,
          status      TEXT NOT NULL,
          output      TEXT,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          error       TEXT,
          logged_at   TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_runs_schedule_id ON runs(schedule_id);
        CREATE INDEX IF NOT EXISTS idx_runs_preset_name ON runs(preset_name);
        CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
        CREATE INDEX IF NOT EXISTS idx_run_logs_run_id ON run_logs(run_id);
        CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON schedules(next_run_at) WHERE enabled = 1;

        INSERT OR REPLACE INTO schema_version (rowid, version) VALUES (1, ${SCHEMA_VERSION});
      `);
            logger.debug("AutomateDatabase schema initialized");
        }
    }

    // --- Schedule CRUD ---

    createSchedule(name: string, presetName: string, interval: string, nextRunAt: string, varsJson?: string): number {
        const stmt = this.db.prepare(`
      INSERT INTO schedules (name, preset_name, interval, next_run_at, vars_json)
      VALUES (?, ?, ?, ?, ?)
    `);
        const result = stmt.run(name, presetName, interval, nextRunAt, varsJson ?? null);
        return Number(result.lastInsertRowid);
    }

    getSchedule(name: string): ScheduleRow | null {
        return this.db.query("SELECT * FROM schedules WHERE name = ?").get(name) as ScheduleRow | null;
    }

    listSchedules(): ScheduleRow[] {
        return this.db.query("SELECT * FROM schedules ORDER BY name").all() as ScheduleRow[];
    }

    getDueSchedules(now: string): ScheduleRow[] {
        return this.db
            .query("SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at")
            .all(now) as ScheduleRow[];
    }

    setScheduleEnabled(name: string, enabled: boolean): void {
        this.db
            .prepare("UPDATE schedules SET enabled = ?, updated_at = datetime('now') WHERE name = ?")
            .run(enabled ? 1 : 0, name);
    }

    deleteSchedule(name: string): void {
        this.db.prepare("DELETE FROM schedules WHERE name = ?").run(name);
    }

    updateScheduleAfterRun(id: number, nextRunAt: string): void {
        this.db
            .prepare(
                "UPDATE schedules SET last_run_at = datetime('now'), next_run_at = ?, updated_at = datetime('now') WHERE id = ?"
            )
            .run(nextRunAt, id);
    }

    // --- Run tracking ---

    startRun(presetName: string, scheduleId: number | null, triggerType: "manual" | "schedule"): number {
        const stmt = this.db.prepare(`
      INSERT INTO runs (schedule_id, preset_name, trigger_type, started_at, status)
      VALUES (?, ?, ?, datetime('now'), 'running')
    `);
        return Number(stmt.run(scheduleId, presetName, triggerType).lastInsertRowid);
    }

    logStep(
        runId: number,
        stepIndex: number,
        stepId: string,
        stepName: string,
        action: string,
        status: string,
        output: string | null,
        durationMs: number,
        error: string | null
    ): void {
        const truncatedOutput = output && output.length > 65536 ? `${output.slice(0, 65536)}\n... (truncated)` : output;
        this.db
            .prepare(`
      INSERT INTO run_logs (run_id, step_index, step_id, step_name, action, status, output, duration_ms, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
            .run(runId, stepIndex, stepId, stepName, action, status, truncatedOutput, Math.round(durationMs), error);
    }

    finishRun(
        runId: number,
        status: "success" | "error" | "cancelled",
        stepCount: number,
        durationMs: number,
        error?: string
    ): void {
        this.db
            .prepare(`
      UPDATE runs SET finished_at = datetime('now'), status = ?, step_count = ?, duration_ms = ?, error = ?
      WHERE id = ?
    `)
            .run(status, stepCount, Math.round(durationMs), error ?? null, runId);
    }

    // --- Query runs ---

    listRuns(limit: number = 50): RunRow[] {
        return this.db.query("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").all(limit) as RunRow[];
    }

    getRun(runId: number): RunRow | null {
        return this.db.query("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | null;
    }

    getRunLogs(runId: number): RunLogRow[] {
        return this.db.query("SELECT * FROM run_logs WHERE run_id = ? ORDER BY step_index").all(runId) as RunLogRow[];
    }

    // --- Cleanup ---

    close(): void {
        this.db.close();
    }
}

// --- Row types ---

export interface ScheduleRow {
    id: number;
    name: string;
    preset_name: string;
    interval: string;
    enabled: number;
    last_run_at: string | null;
    next_run_at: string;
    created_at: string;
    updated_at: string;
    vars_json: string | null;
}

export interface RunRow {
    id: number;
    schedule_id: number | null;
    preset_name: string;
    trigger_type: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    step_count: number;
    duration_ms: number | null;
    error: string | null;
}

export interface RunLogRow {
    id: number;
    run_id: number;
    step_index: number;
    step_id: string;
    step_name: string;
    action: string;
    status: string;
    output: string | null;
    duration_ms: number;
    error: string | null;
    logged_at: string;
}

// --- Singleton ---
let _instance: AutomateDatabase | null = null;

export function getDb(): AutomateDatabase {
    if (!_instance) {
        _instance = new AutomateDatabase();
    }
    return _instance;
}

export function closeDb(): void {
    _instance?.close();
    _instance = null;
}
