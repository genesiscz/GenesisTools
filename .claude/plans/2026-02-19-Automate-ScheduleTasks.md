# Automate Schedule Tasks — Core Infrastructure

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend the `automate` tool with scheduled/recurring task execution, a background daemon, and SQLite-backed run history.

**Architecture:** The automate engine (`src/automate/lib/engine.ts`) gains an optional `RunLogger` callback that records each step to SQLite. A new scheduler daemon process loads scheduled presets and executes them on intervals. CLI commands manage schedules and view history.

**Tech Stack:** Bun, `bun:sqlite`, Commander.js, @clack/prompts, picocolors, macOS launchd

**Branch:** `feat/automate`

---

### Task 1: Interval Parser

**Files:**
- Create: `src/automate/lib/interval-parser.ts`

**Step 1: Create the interval parser module**

Supports these formats (no external cron library):
- `every N second(s)` / `every N minute(s)` / `every N hour(s)` / `every N day(s)`
- `every day at HH:MM`

```typescript
// src/automate/lib/interval-parser.ts

export interface ParsedInterval {
  intervalMs: number;
  atHour?: number;
  atMinute?: number;
  isTimeOfDay: boolean;
}

const INTERVAL_PATTERN = /^every\s+(\d+)\s+(second|minute|hour|day|week)s?$/i;
const DAILY_AT_PATTERN = /^every\s+day\s+at\s+(\d{1,2}):(\d{2})$/i;

const MULTIPLIERS: Record<string, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

export function parseInterval(interval: string): ParsedInterval {
  const dailyMatch = interval.match(DAILY_AT_PATTERN);
  if (dailyMatch) {
    const hour = parseInt(dailyMatch[1], 10);
    const minute = parseInt(dailyMatch[2], 10);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error(`Invalid time: "${interval}" — hour 0-23, minute 0-59`);
    }
    return { intervalMs: 86_400_000, atHour: hour, atMinute: minute, isTimeOfDay: true };
  }

  const match = interval.match(INTERVAL_PATTERN);
  if (!match) {
    throw new Error(`Invalid interval: "${interval}". Expected "every N minutes", "every day at HH:MM", etc.`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  return { intervalMs: value * MULTIPLIERS[unit], isTimeOfDay: false };
}

export function computeNextRunAt(parsed: ParsedInterval, from: Date = new Date()): Date {
  if (parsed.isTimeOfDay && parsed.atHour !== undefined && parsed.atMinute !== undefined) {
    const next = new Date(from);
    next.setHours(parsed.atHour, parsed.atMinute, 0, 0);
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }
  return new Date(from.getTime() + parsed.intervalMs);
}
```

**Step 2: Commit**
```bash
git add src/automate/lib/interval-parser.ts
git commit -m "feat(automate): add interval parser for schedule triggers"
```

---

### Task 2: SQLite Database Module

**Files:**
- Create: `src/automate/lib/db.ts`

**Step 1: Create the database module**

Pattern to follow: `src/ask/output/UsageDatabase.ts` (WAL mode, class-based, prepared statements).

DB location: `~/.genesis-tools/automate/automate.db`

```typescript
// src/automate/lib/db.ts

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
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

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
    return result.lastInsertRowid as number;
  }

  getSchedule(name: string): ScheduleRow | null {
    return this.db.query("SELECT * FROM schedules WHERE name = ?").get(name) as ScheduleRow | null;
  }

  listSchedules(): ScheduleRow[] {
    return this.db.query("SELECT * FROM schedules ORDER BY name").all() as ScheduleRow[];
  }

  getDueSchedules(now: string): ScheduleRow[] {
    return this.db.query(
      "SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at"
    ).all(now) as ScheduleRow[];
  }

  setScheduleEnabled(name: string, enabled: boolean): void {
    this.db.prepare("UPDATE schedules SET enabled = ?, updated_at = datetime('now') WHERE name = ?")
      .run(enabled ? 1 : 0, name);
  }

  deleteSchedule(name: string): void {
    this.db.prepare("DELETE FROM schedules WHERE name = ?").run(name);
  }

  updateScheduleAfterRun(id: number, nextRunAt: string): void {
    this.db.prepare(
      "UPDATE schedules SET last_run_at = datetime('now'), next_run_at = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(nextRunAt, id);
  }

  // --- Run tracking ---

  startRun(presetName: string, scheduleId: number | null, triggerType: "manual" | "schedule"): number {
    const stmt = this.db.prepare(`
      INSERT INTO runs (schedule_id, preset_name, trigger_type, started_at, status)
      VALUES (?, ?, ?, datetime('now'), 'running')
    `);
    return stmt.run(scheduleId, presetName, triggerType).lastInsertRowid as number;
  }

  logStep(runId: number, stepIndex: number, stepId: string, stepName: string, action: string, status: string, output: string | null, durationMs: number, error: string | null): void {
    const truncatedOutput = output && output.length > 65536 ? output.slice(0, 65536) + "\n... (truncated)" : output;
    this.db.prepare(`
      INSERT INTO run_logs (run_id, step_index, step_id, step_name, action, status, output, duration_ms, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(runId, stepIndex, stepId, stepName, action, status, truncatedOutput, durationMs, error);
  }

  finishRun(runId: number, status: "success" | "error" | "cancelled", stepCount: number, durationMs: number, error?: string): void {
    this.db.prepare(`
      UPDATE runs SET finished_at = datetime('now'), status = ?, step_count = ?, duration_ms = ?, error = ?
      WHERE id = ?
    `).run(status, stepCount, durationMs, error ?? null, runId);
  }

  // --- Query runs ---

  listRuns(limit: number = 50): RunRow[] {
    return this.db.query(
      "SELECT * FROM runs ORDER BY started_at DESC LIMIT ?"
    ).all(limit) as RunRow[];
  }

  getRun(runId: number): RunRow | null {
    return this.db.query("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | null;
  }

  getRunLogs(runId: number): RunLogRow[] {
    return this.db.query(
      "SELECT * FROM run_logs WHERE run_id = ? ORDER BY step_index"
    ).all(runId) as RunLogRow[];
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
  if (!_instance) _instance = new AutomateDatabase();
  return _instance;
}

export function closeDb(): void {
  _instance?.close();
  _instance = null;
}
```

**Step 2: Commit**
```bash
git add src/automate/lib/db.ts
git commit -m "feat(automate): add SQLite database for schedules, runs, and run logs"
```

---

### Task 3: RunLogger — Bridge Between Engine and SQLite

**Files:**
- Create: `src/automate/lib/run-logger.ts`

**Step 1: Create RunLogger interface and implementation**

```typescript
// src/automate/lib/run-logger.ts

import type { StepResult } from "./types";
import { getDb, type AutomateDatabase } from "./db";

export interface RunLogger {
  runId: number;
  logStep(stepIndex: number, stepId: string, stepName: string, action: string, result: StepResult): void;
  finishRun(success: boolean, stepCount: number, totalDuration: number, error?: string): void;
}

export function createRunLogger(
  presetName: string,
  scheduleId: number | null,
  triggerType: "manual" | "schedule",
  db?: AutomateDatabase,
): RunLogger {
  const database = db ?? getDb();
  const runId = database.startRun(presetName, scheduleId, triggerType);

  return {
    runId,

    logStep(stepIndex, stepId, stepName, action, result) {
      const output = result.output != null ? (typeof result.output === "string" ? result.output : JSON.stringify(result.output)) : null;
      database.logStep(runId, stepIndex, stepId, stepName, action, result.status, output, result.duration, result.error ?? null);
    },

    finishRun(success, stepCount, totalDuration, error) {
      database.finishRun(runId, success ? "success" : "error", stepCount, totalDuration, error);
    },
  };
}
```

**Step 2: Commit**
```bash
git add src/automate/lib/run-logger.ts
git commit -m "feat(automate): add RunLogger bridge between engine and SQLite"
```

---

### Task 4: Extend Types and Schema for Schedule Triggers

**Files:**
- Modify: `src/automate/lib/types.ts:15-17` (PresetTrigger)
- Modify: `src/automate/lib/types.ts:105` (NotifyAction — add "telegram")
- Modify: `src/automate/lib/schema.ts:29-31` (trigger schema)

**Step 1: Update PresetTrigger type**

In `src/automate/lib/types.ts`, change the `PresetTrigger` interface to a discriminated union:

```typescript
// Replace lines 14-17 with:

/** Trigger configuration — determines how a preset is invoked */
export type PresetTrigger =
  | { type: "manual" }
  | { type: "schedule"; interval: string };
```

Also add `"telegram"` to `NotifyAction`:
```typescript
// Line 105 — change:
export type NotifyAction = "desktop" | "clipboard" | "sound" | "telegram";
```

And extend `NotifyStepParams`:
```typescript
// Line 167-172 — change:
export interface NotifyStepParams {
  title?: string;
  message?: string;
  content?: string;
  sound?: string;
  parse_mode?: string;  // For telegram: "MarkdownV2" | "HTML"
}
```

**Step 2: Update Zod schema in `src/automate/lib/schema.ts`**

Replace the trigger validation (lines 29-31) with a discriminated union:

```typescript
// Replace:
//   trigger: z.object({ type: z.literal("manual") }),
// With:
  trigger: z.discriminatedUnion("type", [
    z.object({ type: z.literal("manual") }),
    z.object({
      type: z.literal("schedule"),
      interval: z.string().min(1, "Schedule interval is required"),
    }),
  ]),
```

**Step 3: Commit**
```bash
git add src/automate/lib/types.ts src/automate/lib/schema.ts
git commit -m "feat(automate): extend types and schema for schedule triggers"
```

---

### Task 5: Integrate RunLogger into Engine

**Files:**
- Modify: `src/automate/lib/engine.ts:33` (add RunLogger parameter)

**Step 1: Add optional RunLogger to `runPreset()`**

In `src/automate/lib/engine.ts`:

```typescript
// Line 8 — add import:
import type { RunLogger } from "./run-logger";

// Line 33 — change signature:
export async function runPreset(
  preset: Preset,
  options: RunOptions = {},
  runLogger?: RunLogger,
): Promise<EngineResult> {
```

Inside the step loop, after `ctx.steps[step.id] = result;` (around line 103), add:
```typescript
      // Log step to SQLite
      runLogger?.logStep(i, step.id, step.name, step.action, result);
```

Also in the catch block (around line 147), after `results.push(...)`:
```typescript
      runLogger?.logStep(i, step.id, step.name, step.action, exceptionResult);
```

At the end (before return, around line 168), add:
```typescript
  // Finish run logging
  runLogger?.finishRun(allSuccess, results.length, totalDuration, allSuccess ? undefined : results.find(r => r.result.status === "error")?.result.error);
```

**Step 2: Commit**
```bash
git add src/automate/lib/engine.ts
git commit -m "feat(automate): integrate RunLogger into engine step execution loop"
```

---

### Task 6: Update `run` Command to Log Runs to SQLite

**Files:**
- Modify: `src/automate/commands/run.ts`

**Step 1: Read the current run command**

Read `src/automate/commands/run.ts` to understand its structure.

**Step 2: Add RunLogger to manual runs**

```typescript
import { createRunLogger } from "@app/automate/lib/run-logger";

// Inside the action handler, before calling runPreset():
const runLogger = createRunLogger(preset.name, null, "manual");

// Pass to engine:
const result = await runPreset(preset, { dryRun, vars, verbose }, options.dryRun ? undefined : runLogger);
```

**Step 3: Commit**
```bash
git add src/automate/commands/run.ts
git commit -m "feat(automate): log manual runs to SQLite via RunLogger"
```

---

### Task 7: Schedule Management CLI Commands

**Files:**
- Create: `src/automate/commands/schedule.ts`

**Step 1: Create the schedule command group**

Uses Commander.js subcommands: `schedule list`, `schedule create`, `schedule enable <name>`, `schedule disable <name>`, `schedule delete <name>`.

```typescript
// src/automate/commands/schedule.ts

import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { getDb } from "@app/automate/lib/db";
import { listPresets } from "@app/automate/lib/storage";
import { parseInterval, computeNextRunAt } from "@app/automate/lib/interval-parser";
import { formatTable } from "@app/utils/table";

export function registerScheduleCommand(program: Command): void {
  const schedule = program.command("schedule").description("Manage scheduled preset executions");

  schedule
    .command("list")
    .alias("ls")
    .description("Show all schedules")
    .action(() => {
      const db = getDb();
      const schedules = db.listSchedules();
      if (schedules.length === 0) {
        p.log.info("No schedules configured. Run: tools automate schedule create");
        return;
      }
      const rows = schedules.map(s => ({
        Name: s.name,
        Preset: s.preset_name,
        Interval: s.interval,
        Enabled: s.enabled ? pc.green("yes") : pc.dim("no"),
        "Last Run": s.last_run_at ?? pc.dim("never"),
        "Next Run": s.enabled ? s.next_run_at : pc.dim("—"),
      }));
      console.log(formatTable(rows));
    });

  schedule
    .command("create")
    .description("Create a new schedule interactively")
    .action(async () => {
      const presets = await listPresets();
      if (presets.length === 0) {
        p.log.error("No presets found. Create one first: tools automate create");
        return;
      }

      const presetName = await p.select({
        message: "Which preset to schedule?",
        options: presets.map(pr => ({ value: pr.fileName.replace(".json", ""), label: `${pr.name} — ${pr.description ?? ""}` })),
      });
      if (p.isCancel(presetName)) return;

      const name = await p.text({
        message: "Schedule name (unique identifier):",
        placeholder: `${presetName}-daily`,
        validate: (val) => {
          if (!/^[a-zA-Z0-9_-]+$/.test(val)) return "Only alphanumeric, hyphens, underscores";
          const db = getDb();
          if (db.getSchedule(val)) return "Schedule name already exists";
        },
      });
      if (p.isCancel(name)) return;

      const interval = await p.text({
        message: "Run interval:",
        placeholder: "every 5 minutes",
        validate: (val) => {
          try { parseInterval(val); } catch (e) { return (e as Error).message; }
        },
      });
      if (p.isCancel(interval)) return;

      const parsed = parseInterval(interval as string);
      const nextRunAt = computeNextRunAt(parsed).toISOString();

      const db = getDb();
      db.createSchedule(name as string, presetName as string, interval as string, nextRunAt);
      p.log.success(`Schedule "${name}" created. Next run: ${nextRunAt}`);
      p.log.info("Start the daemon to begin executing: tools automate daemon start");
    });

  schedule
    .command("enable <name>")
    .description("Enable a schedule")
    .action((name: string) => {
      const db = getDb();
      const existing = db.getSchedule(name);
      if (!existing) { p.log.error(`Schedule "${name}" not found`); return; }
      const parsed = parseInterval(existing.interval);
      const nextRunAt = computeNextRunAt(parsed).toISOString();
      db.setScheduleEnabled(name, true);
      db.updateScheduleAfterRun(existing.id, nextRunAt);
      p.log.success(`Schedule "${name}" enabled. Next run: ${nextRunAt}`);
    });

  schedule
    .command("disable <name>")
    .description("Disable a schedule")
    .action((name: string) => {
      const db = getDb();
      if (!db.getSchedule(name)) { p.log.error(`Schedule "${name}" not found`); return; }
      db.setScheduleEnabled(name, false);
      p.log.success(`Schedule "${name}" disabled`);
    });

  schedule
    .command("delete <name>")
    .description("Delete a schedule")
    .action(async (name: string) => {
      const db = getDb();
      if (!db.getSchedule(name)) { p.log.error(`Schedule "${name}" not found`); return; }
      const confirm = await p.confirm({ message: `Delete schedule "${name}"?` });
      if (p.isCancel(confirm) || !confirm) return;
      db.deleteSchedule(name);
      p.log.success(`Schedule "${name}" deleted`);
    });
}
```

**Step 2: Commit**
```bash
git add src/automate/commands/schedule.ts
git commit -m "feat(automate): add schedule management CLI commands"
```

---

### Task 8: Tasks History CLI Commands

**Files:**
- Create: `src/automate/commands/tasks.ts`

**Step 1: Create the tasks command group**

```typescript
// src/automate/commands/tasks.ts

import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { getDb } from "@app/automate/lib/db";
import { formatTable } from "@app/utils/table";
import { formatDuration } from "@app/utils/format";

export function registerTasksCommand(program: Command): void {
  const tasks = program.command("tasks").description("View execution history");

  tasks
    .command("list", { isDefault: true })
    .alias("ls")
    .description("Show recent runs")
    .option("-n, --limit <n>", "Number of runs to show", "20")
    .action((opts) => {
      const db = getDb();
      const runs = db.listRuns(parseInt(opts.limit));
      if (runs.length === 0) {
        p.log.info("No runs recorded yet.");
        return;
      }
      const rows = runs.map(r => ({
        ID: String(r.id),
        Preset: r.preset_name,
        Trigger: r.trigger_type,
        Status: r.status === "success" ? pc.green(r.status) : r.status === "error" ? pc.red(r.status) : pc.yellow(r.status),
        Started: r.started_at,
        Duration: r.duration_ms != null ? formatDuration(r.duration_ms) : pc.dim("running..."),
        Steps: String(r.step_count),
      }));
      console.log(formatTable(rows));
    });

  tasks
    .command("show <run-id>")
    .description("Show detailed run with per-step logs")
    .action((runIdStr: string) => {
      const db = getDb();
      const runId = parseInt(runIdStr);
      const run = db.getRun(runId);
      if (!run) { p.log.error(`Run #${runId} not found`); return; }

      p.log.info(`Run #${run.id} — ${run.preset_name}`);
      p.log.info(`Trigger: ${run.trigger_type} | Status: ${run.status} | Duration: ${run.duration_ms != null ? formatDuration(run.duration_ms) : "running"}`);
      if (run.error) p.log.error(`Error: ${run.error}`);

      const logs = db.getRunLogs(runId);
      if (logs.length === 0) { p.log.info("No step logs recorded."); return; }

      const rows = logs.map(l => ({
        "#": String(l.step_index + 1),
        Step: l.step_name,
        Action: l.action,
        Status: l.status === "success" ? pc.green(l.status) : l.status === "error" ? pc.red(l.status) : pc.dim(l.status),
        Duration: formatDuration(l.duration_ms),
        Error: l.error ? pc.red(l.error.slice(0, 80)) : "",
      }));
      console.log(formatTable(rows));
    });
}
```

**Step 2: Commit**
```bash
git add src/automate/commands/tasks.ts
git commit -m "feat(automate): add tasks history CLI commands"
```

---

### Task 9: Scheduler Loop

**Files:**
- Create: `src/automate/lib/scheduler.ts`

**Step 1: Create the scheduling loop**

Uses a sleep-until-next pattern. Prevents duplicate concurrent execution of the same schedule.

```typescript
// src/automate/lib/scheduler.ts

import { loadPreset } from "./storage";
import { runPreset } from "./engine";
import { createRunLogger } from "./run-logger";
import { parseInterval, computeNextRunAt } from "./interval-parser";
import { type AutomateDatabase, type ScheduleRow } from "./db";
import logger from "@app/logger";

export async function runSchedulerLoop(db: AutomateDatabase): Promise<void> {
  let running = true;
  const activeRuns = new Set<number>();

  const shutdown = () => { running = false; };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  logger.info("Scheduler loop started");

  while (running) {
    const now = new Date().toISOString();
    const dueSchedules = db.getDueSchedules(now);

    for (const schedule of dueSchedules) {
      if (activeRuns.has(schedule.id)) {
        logger.warn({ scheduleId: schedule.id, name: schedule.name }, "Skipping: still running");
        continue;
      }

      activeRuns.add(schedule.id);
      executeDueSchedule(db, schedule)
        .catch(err => logger.error({ err, scheduleId: schedule.id }, "Schedule execution failed"))
        .finally(() => {
          activeRuns.delete(schedule.id);
          try {
            const parsed = parseInterval(schedule.interval);
            const nextRunAt = computeNextRunAt(parsed).toISOString();
            db.updateScheduleAfterRun(schedule.id, nextRunAt);
          } catch (err) {
            logger.error({ err, scheduleId: schedule.id }, "Failed to update next_run_at");
          }
        });
    }

    const nextWakeup = getNextWakeupMs(db);
    const sleepMs = Math.min(Math.max(nextWakeup, 1000), 60_000);
    logger.debug({ sleepMs }, "Sleeping until next schedule");
    await Bun.sleep(sleepMs);
  }

  if (activeRuns.size > 0) {
    logger.info({ activeCount: activeRuns.size }, "Waiting for active runs...");
    const deadline = Date.now() + 30_000;
    while (activeRuns.size > 0 && Date.now() < deadline) {
      await Bun.sleep(500);
    }
  }

  logger.info("Scheduler loop stopped");
}

async function executeDueSchedule(db: AutomateDatabase, schedule: ScheduleRow): Promise<void> {
  logger.info({ name: schedule.name, preset: schedule.preset_name }, "Executing scheduled preset");
  const preset = await loadPreset(schedule.preset_name);
  const runLogger = createRunLogger(preset.name, schedule.id, "schedule", db);
  const vars = schedule.vars_json ? JSON.parse(schedule.vars_json) : undefined;
  const options = { vars: vars ? Object.entries(vars).map(([k, v]) => `${k}=${v}`) : undefined, verbose: false };
  const result = await runPreset(preset, options, runLogger);
  logger.info({ name: schedule.name, success: result.success, duration: result.totalDuration }, "Schedule execution complete");
}

function getNextWakeupMs(db: AutomateDatabase): number {
  const schedules = db.listSchedules().filter(s => s.enabled);
  if (schedules.length === 0) return 60_000;
  const now = Date.now();
  let earliest = Infinity;
  for (const s of schedules) {
    const nextMs = new Date(s.next_run_at).getTime() - now;
    if (nextMs < earliest) earliest = nextMs;
  }
  return earliest;
}
```

**Step 2: Commit**
```bash
git add src/automate/lib/scheduler.ts
git commit -m "feat(automate): add scheduler loop with sleep-until-next pattern"
```

---

### Task 10: Daemon Process and launchd Management

**Files:**
- Create: `src/automate/lib/daemon.ts`
- Create: `src/automate/lib/launchd.ts`
- Create: `src/automate/commands/daemon.ts`

**Step 1: Create daemon entry point** (`src/automate/lib/daemon.ts`)

```typescript
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDb, closeDb } from "./db";
import { runSchedulerLoop } from "./scheduler";
import { createLogger } from "@app/logger";

const PID_FILE = join(homedir(), ".genesis-tools", "automate", "daemon.pid");

export async function startDaemon(): Promise<void> {
  const log = createLogger("automate-daemon");
  writeFileSync(PID_FILE, String(process.pid));
  log.info({ pid: process.pid }, "Automate daemon starting");

  const db = getDb();
  const cleanup = () => {
    closeDb();
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    log.info("Daemon stopped");
  };

  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  try {
    await runSchedulerLoop(db);
  } catch (err) {
    log.error({ err }, "Daemon crashed");
  } finally {
    cleanup();
  }
}

export function getDaemonPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    const pid = parseInt(Bun.file(PID_FILE).textSync());
    try { process.kill(pid, 0); return pid; } catch { return null; }
  } catch { return null; }
}

if (import.meta.main) { startDaemon(); }
```

**Step 2: Create launchd management** (`src/automate/lib/launchd.ts`)

```typescript
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", "com.genesis-tools.automate.plist");
const LABEL = "com.genesis-tools.automate";

export function generatePlist(): string {
  const home = homedir();
  const daemonScript = resolve(import.meta.dir, "daemon.ts");
  const logDir = join(home, ".genesis-tools", "automate", "logs");
  const bunPath = Bun.which("bun") ?? "/usr/local/bin/bun";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${bunPath}</string><string>run</string><string>${daemonScript}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logDir}/daemon-stdout.log</string>
  <key>StandardErrorPath</key><string>${logDir}/daemon-stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>HOME</key><string>${home}</string><key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:${dirname(bunPath)}</string></dict>
  <key>WorkingDirectory</key><string>${home}</string>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>`;
}

export async function installLaunchd(): Promise<void> {
  mkdirSync(join(homedir(), ".genesis-tools", "automate", "logs"), { recursive: true });
  await Bun.write(PLIST_PATH, generatePlist());
  const proc = Bun.spawn(["launchctl", "load", PLIST_PATH], { stdio: ["ignore", "pipe", "pipe"] });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`launchctl load failed: ${await new Response(proc.stderr).text()}`);
}

export async function uninstallLaunchd(): Promise<void> {
  if (existsSync(PLIST_PATH)) {
    await Bun.spawn(["launchctl", "unload", PLIST_PATH], { stdio: ["ignore", "pipe", "pipe"] }).exited;
    unlinkSync(PLIST_PATH);
  }
}

export async function getDaemonStatus(): Promise<{ installed: boolean; running: boolean; pid: number | null }> {
  const installed = existsSync(PLIST_PATH);
  if (!installed) return { installed: false, running: false, pid: null };
  const proc = Bun.spawn(["launchctl", "list", LABEL], { stdio: ["ignore", "pipe", "pipe"] });
  const stdout = await new Response(proc.stdout).text();
  if (await proc.exited !== 0) return { installed: true, running: false, pid: null };
  const pidMatch = stdout.match(/^(\d+)/m);
  const pid = pidMatch ? parseInt(pidMatch[1], 10) : null;
  return { installed, running: pid != null && pid > 0, pid };
}
```

**Step 3: Create daemon CLI** (`src/automate/commands/daemon.ts`)

```typescript
import { Command } from "commander";
import * as p from "@clack/prompts";
import { startDaemon, getDaemonPid } from "@app/automate/lib/daemon";
import { installLaunchd, uninstallLaunchd, getDaemonStatus } from "@app/automate/lib/launchd";

export function registerDaemonCommand(program: Command): void {
  const daemon = program.command("daemon").description("Manage the scheduler daemon");

  daemon.command("start").description("Run scheduler in foreground").action(async () => {
    const existing = getDaemonPid();
    if (existing) { p.log.error(`Daemon already running (PID ${existing})`); return; }
    p.log.info("Starting scheduler daemon in foreground... (Ctrl+C to stop)");
    await startDaemon();
  });

  daemon.command("install").description("Install macOS launchd plist").action(async () => {
    try { await installLaunchd(); p.log.success("Daemon installed via launchd"); }
    catch (err) { p.log.error(`Failed: ${(err as Error).message}`); }
  });

  daemon.command("uninstall").description("Remove launchd plist").action(async () => {
    await uninstallLaunchd(); p.log.success("Daemon uninstalled");
  });

  daemon.command("status").description("Check daemon status").action(async () => {
    const status = await getDaemonStatus();
    const fgPid = getDaemonPid();
    if (status.running) p.log.success(`Daemon running (launchd, PID ${status.pid})`);
    else if (fgPid) p.log.success(`Daemon running (foreground, PID ${fgPid})`);
    else if (status.installed) p.log.warn("Daemon installed but not running");
    else p.log.info("Daemon not installed. Run: tools automate daemon install");
  });
}
```

**Step 4: Commit**
```bash
git add src/automate/lib/daemon.ts src/automate/lib/launchd.ts src/automate/commands/daemon.ts
git commit -m "feat(automate): add daemon process with launchd support"
```

---

### Task 11: Configure Wizard

**Files:**
- Create: `src/automate/commands/configure.ts`

**Step 1: Create the interactive configure command**

```typescript
import { Command } from "commander";
import * as p from "@clack/prompts";

export function registerConfigureCommand(program: Command): void {
  program.command("configure").description("Interactive setup wizard").action(async () => {
    p.intro("automate configure");
    const section = await p.select({
      message: "What would you like to configure?",
      options: [
        { value: "telegram", label: "Telegram Bot", description: "Set up notifications via Telegram" },
        { value: "done", label: "Done", description: "Exit configuration" },
      ],
    });
    if (p.isCancel(section) || section === "done") { p.outro("Configuration complete"); return; }
    if (section === "telegram") {
      p.log.info("Launching Telegram Bot configuration...");
      const toolsPath = new URL("../../../tools", import.meta.url).pathname;
      const proc = Bun.spawn(["bun", "run", toolsPath, "telegram-bot", "configure"], { stdio: ["inherit", "inherit", "inherit"] });
      await proc.exited;
    }
    p.outro("Configuration complete");
  });
}
```

**Step 2: Commit**
```bash
git add src/automate/commands/configure.ts
git commit -m "feat(automate): add interactive configure wizard"
```

---

### Task 12: Register All New Commands in index.ts

**Files:**
- Modify: `src/automate/index.ts`

**Step 1: Add imports and register new command groups**

Add imports:
```typescript
import { registerScheduleCommand } from "@app/automate/commands/schedule.ts";
import { registerTasksCommand } from "@app/automate/commands/tasks.ts";
import { registerDaemonCommand } from "@app/automate/commands/daemon.ts";
import { registerConfigureCommand } from "@app/automate/commands/configure.ts";
```

Add registrations after existing ones:
```typescript
registerScheduleCommand(program);
registerTasksCommand(program);
registerDaemonCommand(program);
registerConfigureCommand(program);
```

**Step 2: Commit**
```bash
git add src/automate/index.ts
git commit -m "feat(automate): register schedule, tasks, daemon, configure commands"
```

---

## Verification

1. `tools automate schedule list` — empty table
2. `tools automate schedule create` — interactive wizard
3. `tools automate schedule list` — new schedule shows
4. `tools automate daemon start` — scheduler loop runs in foreground
5. `tools automate tasks` — after manual run via `tools automate run <preset>`
6. `tools automate tasks show <id>` — per-step logs
7. `tools automate daemon install` — launchd plist installed
8. `tools automate daemon status` — running
