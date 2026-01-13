/**
 * PowerSync Database - Client-only module
 *
 * PowerSync is browser-only (uses IndexedDB, Web Workers, WASM).
 * This module guards against SSR imports by checking for window.
 */

// No imports from @powersync/web at module level to avoid SSR issues
// Types are defined inline or obtained dynamically

// PowerSync Schema Definition (safe - no runtime dependencies)
// We need to dynamically import the schema classes for SSR safety
// biome-ignore lint/suspicious/noExplicitAny: Avoid PowerSync type imports during SSR
let APP_SCHEMA: any = null;

// Database instance (client-only)
// biome-ignore lint/suspicious/noExplicitAny: Avoid PowerSync type imports during SSR
let db: any = null;
let initialized = false;
let connector: ReturnType<typeof import("./powersync-connector").createConnector> | null = null;

// Schema definition (will be initialized on client)
const schemaConfig = {
    timers: {
        // Core fields
        name: "text" as const,
        timer_type: "text" as const, // 'stopwatch' | 'countdown' | 'pomodoro'

        // State fields (SQLite stores booleans as integers)
        is_running: "integer" as const, // 0 = false, 1 = true
        elapsed_time: "integer" as const, // Elapsed time in milliseconds
        duration: "integer" as const, // Duration for countdown/pomodoro timers

        // Laps stored as JSON string (array of LapEntry)
        laps: "text" as const,

        // User ownership
        user_id: "text" as const,

        // Timestamps (ISO strings)
        created_at: "text" as const,
        updated_at: "text" as const,

        // Enhanced functionality
        show_total: "integer" as const, // 0 or 1 - toggle total time display
        first_start_time: "text" as const, // ISO string - first time timer was started
        start_time: "text" as const, // ISO string - current session start time

        // Pomodoro-specific fields
        pomodoro_settings: "text" as const, // JSON stringified PomodoroSettings
        pomodoro_phase: "text" as const, // 'work' | 'short_break' | 'long_break'
        pomodoro_session_count: "integer" as const,
    },

    activity_logs: {
        // Core fields
        timer_id: "text" as const,
        timer_name: "text" as const,
        user_id: "text" as const,
        event_type: "text" as const, // 'start' | 'pause' | 'reset' | 'lap' | 'complete' | 'time_edit' | 'pomodoro_phase_change'
        timestamp: "text" as const, // ISO string

        // Event details
        elapsed_at_event: "integer" as const, // ms elapsed when event occurred
        session_duration: "integer" as const, // For pause events: duration of this session
        previous_value: "integer" as const, // For time_edit: previous elapsed time
        new_value: "integer" as const, // For time_edit: new elapsed time
        metadata: "text" as const, // JSON stringified additional data
    },

    // Example: Todos table for live sync demo
    todos: {
        text: "text" as const,
        completed: "integer" as const, // 0 or 1
        user_id: "text" as const,
        created_at: "text" as const,
        updated_at: "text" as const,
    },
};

/**
 * Initialize PowerSync on the client
 * This must be called before using db or APP_SCHEMA
 */
async function ensurePowerSync() {
    if (typeof window === "undefined") {
        throw new Error("[PowerSync] Cannot initialize on server - browser only");
    }

    if (db && APP_SCHEMA) {
        return { db, APP_SCHEMA };
    }

    console.log('[PowerSync] Importing PowerSync modules...');

    // Dynamic import of PowerSync (browser-only)
    const { PowerSyncDatabase, Schema, Table, column } = await import("@powersync/web");
    console.log('[PowerSync] ✓ PowerSync imported');

    // Import WASM SQLite
    await import("@journeyapps/wa-sqlite");
    console.log('[PowerSync] ✓ WASM SQLite imported');

    // Import connector
    const { createConnector } = await import("./powersync-connector");
    console.log('[PowerSync] ✓ Connector imported');

    // Build schema from config
    console.log('[PowerSync] Building schema...');
    APP_SCHEMA = new Schema({
        timers: new Table({
            name: column.text,
            timer_type: column.text,
            is_running: column.integer,
            elapsed_time: column.integer,
            duration: column.integer,
            laps: column.text,
            user_id: column.text,
            created_at: column.text,
            updated_at: column.text,
            show_total: column.integer,
            first_start_time: column.text,
            start_time: column.text,
            pomodoro_settings: column.text,
            pomodoro_phase: column.text,
            pomodoro_session_count: column.integer,
        }),
        activity_logs: new Table({
            timer_id: column.text,
            timer_name: column.text,
            user_id: column.text,
            event_type: column.text,
            timestamp: column.text,
            elapsed_at_event: column.integer,
            session_duration: column.integer,
            previous_value: column.integer,
            new_value: column.integer,
            metadata: column.text,
        }),
        todos: new Table({
            text: column.text,
            completed: column.integer,
            user_id: column.text,
            created_at: column.text,
            updated_at: column.text,
        }),
    });
    console.log('[PowerSync] ✓ Schema created');

    // Create database instance
    console.log('[PowerSync] Creating PowerSyncDatabase instance...');
    db = new PowerSyncDatabase({
        database: {
            dbFilename: "dashboard.sqlite",
            dbLocation: "default",
        },
        schema: APP_SCHEMA,
        flags: {
            useWebWorker: false,
        },
    });
    console.log('[PowerSync] ✓ Database instance created');

    console.log('[PowerSync] Creating connector...');
    connector = createConnector();
    console.log('[PowerSync] ✓ Connector created');

    return { db, APP_SCHEMA };
}

/**
 * Get the PowerSync database instance
 * Throws if called on server or before initialization
 */
// biome-ignore lint/suspicious/noExplicitAny: Avoid PowerSync type imports during SSR
export function getDb(): any {
    if (!db) {
        throw new Error("[PowerSync] Database not initialized. Call initializeDatabase() first.");
    }
    return db;
}

/**
 * Get the schema - for use with TanStack DB collections
 * Returns null on server, schema on client after init
 */
export function getSchema() {
    return APP_SCHEMA;
}

// For backwards compatibility - these getters ensure client-only access
// Using Object.defineProperty to create lazy getters
export { db, APP_SCHEMA };

/**
 * Initialize the database for local-only mode
 * Call this at app startup before using the database
 */
export async function initializeDatabase(): Promise<void> {
    if (typeof window === "undefined") {
        console.log("[PowerSync] Skipping init on server");
        return;
    }

    if (initialized) {
        console.log("[PowerSync] Already initialized, skipping");
        return;
    }

    console.log("[PowerSync] Starting initialization...");

    try {
        const { db: database } = await ensurePowerSync();

        console.log("[PowerSync] Starting db.init()...");
        console.log("[PowerSync] This may take 5-30 seconds on first run...");

        // Add timeout to detect stuck initialization
        const initPromise = database.init();
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error('PowerSync init timeout after 30 seconds. Check browser console for errors. Try: indexedDB.deleteDatabase("dashboard.sqlite") then refresh.'));
            }, 30000); // 30 second timeout (first init can be slow)
        });

        await Promise.race([initPromise, timeoutPromise]);
        console.log("[PowerSync] ✓ db.init() completed");

        initialized = true;
        console.log("[PowerSync] Database initialized (local-only mode)");
    } catch (err) {
        console.error("[PowerSync] Initialization failed:", err);
        throw err;
    }
}

/**
 * Manually sync pending changes to server
 * Call this after write operations (create, update, delete)
 */
export async function syncToServer(): Promise<void> {
    if (typeof window === "undefined") {
        console.log("[PowerSync] Skipping sync on server");
        return;
    }

    if (!initialized || !connector || !db) {
        console.warn("[PowerSync] Cannot sync - database not initialized");
        return;
    }

    try {
        console.log("[PowerSync] Starting manual sync to server...");
        await connector.uploadData(db);
        console.log("[PowerSync] Manual sync completed");
    } catch (err) {
        console.error("[PowerSync] Manual sync failed:", err);
        // Don't throw - let the app continue, sync will retry later
    }
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
    if (db) {
        await db.disconnectAndClear();
    }
    initialized = false;
}
