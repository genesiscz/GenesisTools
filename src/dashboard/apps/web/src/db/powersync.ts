import { PowerSyncDatabase, Schema, Table, column } from '@powersync/web'

// Import WASM SQLite for browser support
import '@journeyapps/wa-sqlite'

/**
 * PowerSync Schema Definition
 *
 * This defines the local SQLite schema that will be synced with the backend.
 * All tables here will be available offline and sync automatically when online.
 *
 * TODO: Update timers table to match new @dashboard/shared types:
 * - Rename: type → timer_type, paused_time → elapsed_time, countdown_duration → duration
 * - Add: show_total, first_start_time, start_time, pomodoro_settings, pomodoro_phase, pomodoro_session_count
 * - Update laps format to new LapEntry schema (number, lapTime, splitTime, timestamp)
 * See: /packages/shared/src/types/timer.ts for reference
 */
export const APP_SCHEMA = new Schema({
  timers: new Table({
    // Core fields
    name: column.text,
    type: column.text, // 'stopwatch' | 'countdown' | 'pomodoro'

    // State fields (SQLite stores booleans as integers)
    is_running: column.integer, // 0 = false, 1 = true
    paused_time: column.integer, // Elapsed time in milliseconds
    countdown_duration: column.integer, // Duration for countdown timers

    // Laps stored as JSON string
    laps: column.text,

    // User ownership
    user_id: column.text,

    // Timestamps (ISO strings)
    created_at: column.text,
    updated_at: column.text,
  }),
})

/**
 * PowerSync Database Instance
 *
 * This is the main database instance used throughout the app.
 * It provides offline-first SQLite storage with automatic sync.
 */
export const db = new PowerSyncDatabase({
  database: {
    dbFilename: 'dashboard.sqlite',
  },
  schema: APP_SCHEMA,
})

/**
 * Initialize the database connection
 * Call this at app startup before using the database
 */
export async function initializeDatabase(): Promise<void> {
  await db.init()
}

/**
 * Connect to the PowerSync service for sync
 * @param connector - The backend connector for authentication and data upload
 */
export async function connectDatabase(connector: unknown): Promise<void> {
  await db.connect(connector as Parameters<typeof db.connect>[0])
}

/**
 * Disconnect from the PowerSync service
 * Call this during logout or app cleanup
 */
export async function disconnectDatabase(): Promise<void> {
  await db.disconnectAndClear()
}
