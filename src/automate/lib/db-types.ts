import type { Generated } from "kysely";

export interface SchedulesTable {
    id: Generated<number>;
    name: string;
    preset_name: string;
    interval: string;
    enabled: Generated<number>;
    last_run_at: string | null;
    next_run_at: string;
    created_at: Generated<string>;
    updated_at: Generated<string>;
    vars_json: string | null;
}

export interface RunsTable {
    id: Generated<number>;
    schedule_id: number | null;
    preset_name: string;
    trigger_type: Generated<string>;
    started_at: string;
    finished_at: string | null;
    status: Generated<string>;
    step_count: Generated<number>;
    duration_ms: number | null;
    error: string | null;
}

export interface RunLogsTable {
    id: Generated<number>;
    run_id: number;
    step_index: number;
    step_id: string;
    step_name: string;
    action: string;
    status: string;
    output: string | null;
    duration_ms: Generated<number>;
    error: string | null;
    logged_at: Generated<string>;
}

export interface SchemaVersionTable {
    version: number;
}

export interface AutomateDB {
    schedules: SchedulesTable;
    runs: RunsTable;
    run_logs: RunLogsTable;
    schema_version: SchemaVersionTable;
}

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
