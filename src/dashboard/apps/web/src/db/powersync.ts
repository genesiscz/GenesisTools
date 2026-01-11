import { PowerSyncDatabase, Schema, Table, column } from "@powersync/web";

// Import WASM SQLite for browser support
import "@journeyapps/wa-sqlite";

import { createConnector } from "./powersync-connector";

/**
 * PowerSync Schema Definition
 *
 * This defines the local SQLite schema that will be synced with the backend.
 * All tables here will be available offline and sync automatically when online.
 */
export const APP_SCHEMA = new Schema({
    timers: new Table({
        // Core fields
        name: column.text,
        timer_type: column.text, // 'stopwatch' | 'countdown' | 'pomodoro'

        // State fields (SQLite stores booleans as integers)
        is_running: column.integer, // 0 = false, 1 = true
        elapsed_time: column.integer, // Elapsed time in milliseconds
        duration: column.integer, // Duration for countdown/pomodoro timers

        // Laps stored as JSON string (array of LapEntry)
        laps: column.text,

        // User ownership
        user_id: column.text,

        // Timestamps (ISO strings)
        created_at: column.text,
        updated_at: column.text,

        // Enhanced functionality
        show_total: column.integer, // 0 or 1 - toggle total time display
        first_start_time: column.text, // ISO string - first time timer was started
        start_time: column.text, // ISO string - current session start time

        // Pomodoro-specific fields
        pomodoro_settings: column.text, // JSON stringified PomodoroSettings
        pomodoro_phase: column.text, // 'work' | 'short_break' | 'long_break'
        pomodoro_session_count: column.integer,
    }),

    activity_logs: new Table({
        // Core fields
        timer_id: column.text,
        timer_name: column.text,
        user_id: column.text,
        event_type: column.text, // 'start' | 'pause' | 'reset' | 'lap' | 'complete' | 'time_edit' | 'pomodoro_phase_change'
        timestamp: column.text, // ISO string

        // Event details
        elapsed_at_event: column.integer, // ms elapsed when event occurred
        session_duration: column.integer, // For pause events: duration of this session
        previous_value: column.integer, // For time_edit: previous elapsed time
        new_value: column.integer, // For time_edit: new elapsed time
        metadata: column.text, // JSON stringified additional data
    }),
});

/**
 * PowerSync Database Instance
 *
 * This is the main database instance used throughout the app.
 * It provides offline-first SQLite storage with automatic sync.
 */
export const db = new PowerSyncDatabase({
    database: {
        dbFilename: "dashboard.sqlite",
    },
    schema: APP_SCHEMA,
});

let initialized = false;

/**
 * Initialize the database and connect to backend for sync
 * Call this at app startup before using the database
 */
export async function initializeDatabase(): Promise<void> {
    if (initialized) return;

    await db.init();

    // Connect with our Nitro backend connector for CRUD uploads
    const connector = createConnector();
    await db.connect(connector);

    initialized = true;
    console.log("[PowerSync] Database initialized and connected to backend");
}

/**
 * Check if database is initialized
 */
export function isDatabaseInitialized(): boolean {
    return initialized;
}

/**
 * Disconnect from the backend and clear local data
 * Call this during logout or app cleanup
 */
export async function disconnectDatabase(): Promise<void> {
    await db.disconnectAndClear();
    initialized = false;
}
