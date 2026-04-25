/**
 * Storage configuration for Assistant module
 */

/**
 * Sync configuration
 */
export const ASSISTANT_SYNC_CONFIG = {
    // Debounce delay for saving to storage (ms)
    SAVE_DEBOUNCE: 300,

    // Maximum entries in completion history before pruning
    MAX_COMPLETION_ENTRIES: 500,

    // Days to keep completion entries
    COMPLETION_RETENTION_DAYS: 90,

    // Maximum parking history entries per task
    MAX_PARKING_HISTORY_PER_TASK: 20,
} as const;
