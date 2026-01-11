import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'

// Database file location - stored in project root .data folder
const DATA_DIR = path.join(process.cwd(), '.data')
const DB_PATH = path.join(DATA_DIR, 'dashboard.sqlite')

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

// Create database instance
export const db = new Database(DB_PATH)

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL')

// Initialize schema
db.exec(`
  -- Timers table
  CREATE TABLE IF NOT EXISTS timers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    timer_type TEXT NOT NULL CHECK (timer_type IN ('stopwatch', 'countdown', 'pomodoro')),
    is_running INTEGER NOT NULL DEFAULT 0,
    elapsed_time INTEGER NOT NULL DEFAULT 0,
    duration INTEGER,
    laps TEXT DEFAULT '[]',
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    show_total INTEGER NOT NULL DEFAULT 0,
    first_start_time TEXT,
    start_time TEXT,
    pomodoro_settings TEXT,
    pomodoro_phase TEXT,
    pomodoro_session_count INTEGER DEFAULT 0
  );

  -- Activity logs table
  CREATE TABLE IF NOT EXISTS activity_logs (
    id TEXT PRIMARY KEY,
    timer_id TEXT NOT NULL,
    timer_name TEXT NOT NULL,
    user_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    elapsed_at_event INTEGER NOT NULL DEFAULT 0,
    session_duration INTEGER,
    previous_value INTEGER,
    new_value INTEGER,
    metadata TEXT DEFAULT '{}'
  );

  -- Indexes for efficient queries
  CREATE INDEX IF NOT EXISTS idx_timers_user_id ON timers(user_id);
  CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id ON activity_logs(user_id);
  CREATE INDEX IF NOT EXISTS idx_activity_logs_timer_id ON activity_logs(timer_id);
  CREATE INDEX IF NOT EXISTS idx_activity_logs_timestamp ON activity_logs(timestamp);
`)

// Prepared statements for common operations
export const timerStatements = {
  getAll: db.prepare<[string]>(`
    SELECT * FROM timers WHERE user_id = ? ORDER BY created_at DESC
  `),

  getById: db.prepare<[string]>(`
    SELECT * FROM timers WHERE id = ?
  `),

  insert: db.prepare(`
    INSERT INTO timers (
      id, name, timer_type, is_running, elapsed_time, duration, laps,
      user_id, created_at, updated_at, show_total, first_start_time,
      start_time, pomodoro_settings, pomodoro_phase, pomodoro_session_count
    ) VALUES (
      @id, @name, @timer_type, @is_running, @elapsed_time, @duration, @laps,
      @user_id, @created_at, @updated_at, @show_total, @first_start_time,
      @start_time, @pomodoro_settings, @pomodoro_phase, @pomodoro_session_count
    )
  `),

  update: db.prepare(`
    UPDATE timers SET
      name = @name,
      timer_type = @timer_type,
      is_running = @is_running,
      elapsed_time = @elapsed_time,
      duration = @duration,
      laps = @laps,
      updated_at = @updated_at,
      show_total = @show_total,
      first_start_time = @first_start_time,
      start_time = @start_time,
      pomodoro_settings = @pomodoro_settings,
      pomodoro_phase = @pomodoro_phase,
      pomodoro_session_count = @pomodoro_session_count
    WHERE id = @id
  `),

  delete: db.prepare<[string]>(`
    DELETE FROM timers WHERE id = ?
  `),

  upsert: db.prepare(`
    INSERT INTO timers (
      id, name, timer_type, is_running, elapsed_time, duration, laps,
      user_id, created_at, updated_at, show_total, first_start_time,
      start_time, pomodoro_settings, pomodoro_phase, pomodoro_session_count
    ) VALUES (
      @id, @name, @timer_type, @is_running, @elapsed_time, @duration, @laps,
      @user_id, @created_at, @updated_at, @show_total, @first_start_time,
      @start_time, @pomodoro_settings, @pomodoro_phase, @pomodoro_session_count
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      timer_type = excluded.timer_type,
      is_running = excluded.is_running,
      elapsed_time = excluded.elapsed_time,
      duration = excluded.duration,
      laps = excluded.laps,
      updated_at = excluded.updated_at,
      show_total = excluded.show_total,
      first_start_time = excluded.first_start_time,
      start_time = excluded.start_time,
      pomodoro_settings = excluded.pomodoro_settings,
      pomodoro_phase = excluded.pomodoro_phase,
      pomodoro_session_count = excluded.pomodoro_session_count
  `),
}

export const activityStatements = {
  getAll: db.prepare<[string]>(`
    SELECT * FROM activity_logs WHERE user_id = ? ORDER BY timestamp DESC LIMIT 1000
  `),

  getByTimerId: db.prepare<[string, string]>(`
    SELECT * FROM activity_logs WHERE timer_id = ? AND user_id = ? ORDER BY timestamp DESC
  `),

  insert: db.prepare(`
    INSERT INTO activity_logs (
      id, timer_id, timer_name, user_id, event_type, timestamp,
      elapsed_at_event, session_duration, previous_value, new_value, metadata
    ) VALUES (
      @id, @timer_id, @timer_name, @user_id, @event_type, @timestamp,
      @elapsed_at_event, @session_duration, @previous_value, @new_value, @metadata
    )
  `),

  upsert: db.prepare(`
    INSERT INTO activity_logs (
      id, timer_id, timer_name, user_id, event_type, timestamp,
      elapsed_at_event, session_duration, previous_value, new_value, metadata
    ) VALUES (
      @id, @timer_id, @timer_name, @user_id, @event_type, @timestamp,
      @elapsed_at_event, @session_duration, @previous_value, @new_value, @metadata
    )
    ON CONFLICT(id) DO NOTHING
  `),

  clear: db.prepare<[string]>(`
    DELETE FROM activity_logs WHERE user_id = ?
  `),
}

// Type for timer row
export interface TimerRow {
  id: string
  name: string
  timer_type: string
  is_running: number
  elapsed_time: number
  duration: number | null
  laps: string
  user_id: string
  created_at: string
  updated_at: string
  show_total: number
  first_start_time: string | null
  start_time: string | null
  pomodoro_settings: string | null
  pomodoro_phase: string | null
  pomodoro_session_count: number
}

export interface ActivityLogRow {
  id: string
  timer_id: string
  timer_name: string
  user_id: string
  event_type: string
  timestamp: string
  elapsed_at_event: number
  session_duration: number | null
  previous_value: number | null
  new_value: number | null
  metadata: string
}
