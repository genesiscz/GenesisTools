import type { StorageMode } from "./types";

/**
 * Storage mode configuration
 *
 * Both modes sync to backend SQLite. The difference is local storage:
 *
 * 'localstorage' - Uses browser localStorage for local persistence
 *                  + cross-tab sync via BroadcastChannel
 *                  + HTTP sync to backend SQLite
 *
 * 'powersync'    - Uses PowerSync SQLite for offline-first local persistence
 *                  + automatic bi-directional sync to backend SQLite
 *                  + better for large datasets and complex queries
 */
export const STORAGE_MODE: StorageMode = "localstorage";

/**
 * API endpoints for server sync
 */
export const API_ENDPOINTS = {
    TIMERS: "/api/timers",
    TIMERS_SYNC: "/api/timers/sync",
    ACTIVITY_LOGS: "/api/activity-logs",
} as const;

/**
 * Sync configuration
 */
export const SYNC_CONFIG = {
    // Debounce delay for saving to storage (ms)
    SAVE_DEBOUNCE: 300,

    // Interval for server sync (ms) - 5 minutes
    SERVER_SYNC_INTERVAL: 5 * 60 * 1000,

    // Maximum entries in activity log before pruning
    MAX_ACTIVITY_LOG_ENTRIES: 1000,

    // Days to keep activity log entries
    ACTIVITY_LOG_RETENTION_DAYS: 30,
} as const;

/**
 * Check if we should use PowerSync
 */
export function usePowerSync(): boolean {
    return STORAGE_MODE === "powersync";
}

/**
 * Check if we should use localStorage
 */
export function useLocalStorage(): boolean {
    return STORAGE_MODE === "localstorage";
}
