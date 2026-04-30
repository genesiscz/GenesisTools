import { homedir } from "node:os";
import { join } from "node:path";
import logger from "@app/logger";
import { createKyselyClient, type DatabaseClient } from "@app/utils/database";
import { sql } from "kysely";
import type { AutomateDB, RunLogRow, RunRow, ScheduleRow } from "./db-types";

export type { RunLogRow, RunRow, ScheduleRow } from "./db-types";

const DB_PATH = join(homedir(), ".genesis-tools", "automate", "automate.db");
const SCHEMA_VERSION = 1;

const BOOTSTRAP: string[] = [
    `CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS schedules (
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
    )`,
    `CREATE TABLE IF NOT EXISTS runs (
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
    )`,
    `CREATE TABLE IF NOT EXISTS run_logs (
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
    )`,
    `CREATE INDEX IF NOT EXISTS idx_runs_schedule_id ON runs(schedule_id)`,
    `CREATE INDEX IF NOT EXISTS idx_runs_preset_name ON runs(preset_name)`,
    `CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at)`,
    `CREATE INDEX IF NOT EXISTS idx_run_logs_run_id ON run_logs(run_id)`,
    `CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON schedules(next_run_at) WHERE enabled = 1`,
];

export class AutomateDatabase {
    private readonly client: DatabaseClient<AutomateDB>;

    constructor(dbPath: string = DB_PATH) {
        this.client = createKyselyClient<AutomateDB>({
            path: dbPath,
            bootstrap: BOOTSTRAP,
            pragmas: { foreignKeys: true },
        });

        this.recordSchemaVersionIfNeeded();
    }

    private recordSchemaVersionIfNeeded(): void {
        const row = this.client.raw.query("SELECT version FROM schema_version LIMIT 1").get() as {
            version: number;
        } | null;

        if (!row || row.version < SCHEMA_VERSION) {
            this.client.raw.run("INSERT OR REPLACE INTO schema_version (rowid, version) VALUES (1, ?)", [
                SCHEMA_VERSION,
            ]);
            logger.debug("AutomateDatabase schema initialized");
        }
    }

    async createSchedule(
        name: string,
        presetName: string,
        interval: string,
        nextRunAt: string,
        varsJson?: string
    ): Promise<number> {
        const result = await this.client.kysely
            .insertInto("schedules")
            .values({
                name,
                preset_name: presetName,
                interval,
                next_run_at: nextRunAt,
                vars_json: varsJson ?? null,
            })
            .executeTakeFirstOrThrow();

        return Number(result.insertId ?? 0);
    }

    async getSchedule(name: string): Promise<ScheduleRow | null> {
        const row = await this.client.kysely
            .selectFrom("schedules")
            .selectAll()
            .where("name", "=", name)
            .executeTakeFirst();

        return (row as ScheduleRow | undefined) ?? null;
    }

    async listSchedules(): Promise<ScheduleRow[]> {
        const rows = await this.client.kysely.selectFrom("schedules").selectAll().orderBy("name").execute();
        return rows as ScheduleRow[];
    }

    async getDueSchedules(now: string): Promise<ScheduleRow[]> {
        const rows = await this.client.kysely
            .selectFrom("schedules")
            .selectAll()
            .where("enabled", "=", 1)
            .where("next_run_at", "<=", now)
            .orderBy("next_run_at")
            .execute();
        return rows as ScheduleRow[];
    }

    async setScheduleEnabled(name: string, enabled: boolean): Promise<void> {
        await this.client.kysely
            .updateTable("schedules")
            .set({ enabled: enabled ? 1 : 0, updated_at: sql`datetime('now')` })
            .where("name", "=", name)
            .execute();
    }

    async deleteSchedule(name: string): Promise<void> {
        await this.client.kysely.deleteFrom("schedules").where("name", "=", name).execute();
    }

    async updateScheduleAfterRun(id: number, nextRunAt: string): Promise<void> {
        await this.client.kysely
            .updateTable("schedules")
            .set({
                last_run_at: sql`datetime('now')`,
                next_run_at: nextRunAt,
                updated_at: sql`datetime('now')`,
            })
            .where("id", "=", id)
            .execute();
    }

    async startRun(presetName: string, scheduleId: number | null, triggerType: "manual" | "schedule"): Promise<number> {
        const result = await this.client.kysely
            .insertInto("runs")
            .values({
                schedule_id: scheduleId,
                preset_name: presetName,
                trigger_type: triggerType,
                started_at: sql`datetime('now')`,
                status: "running",
            })
            .executeTakeFirstOrThrow();

        return Number(result.insertId ?? 0);
    }

    async logStep(
        runId: number,
        stepIndex: number,
        stepId: string,
        stepName: string,
        action: string,
        status: string,
        output: string | null,
        durationMs: number,
        error: string | null
    ): Promise<void> {
        const truncatedOutput = output && output.length > 65536 ? `${output.slice(0, 65536)}\n... (truncated)` : output;

        await this.client.kysely
            .insertInto("run_logs")
            .values({
                run_id: runId,
                step_index: stepIndex,
                step_id: stepId,
                step_name: stepName,
                action,
                status,
                output: truncatedOutput,
                duration_ms: Math.round(durationMs),
                error,
            })
            .execute();
    }

    async finishRun(
        runId: number,
        status: "success" | "error" | "cancelled",
        stepCount: number,
        durationMs: number,
        error?: string
    ): Promise<void> {
        await this.client.kysely
            .updateTable("runs")
            .set({
                finished_at: sql`datetime('now')`,
                status,
                step_count: stepCount,
                duration_ms: Math.round(durationMs),
                error: error ?? null,
            })
            .where("id", "=", runId)
            .execute();
    }

    async listRuns(limit = 50): Promise<RunRow[]> {
        const rows = await this.client.kysely
            .selectFrom("runs")
            .selectAll()
            .orderBy("started_at", "desc")
            .limit(limit)
            .execute();
        return rows as RunRow[];
    }

    async getRun(runId: number): Promise<RunRow | null> {
        const row = await this.client.kysely.selectFrom("runs").selectAll().where("id", "=", runId).executeTakeFirst();
        return (row as RunRow | undefined) ?? null;
    }

    async getRunLogs(runId: number): Promise<RunLogRow[]> {
        const rows = await this.client.kysely
            .selectFrom("run_logs")
            .selectAll()
            .where("run_id", "=", runId)
            .orderBy("step_index")
            .execute();
        return rows as RunLogRow[];
    }

    close(): void {
        this.client.close();
    }
}

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
