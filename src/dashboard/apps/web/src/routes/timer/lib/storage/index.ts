import type { StorageAdapter } from './types'
import { STORAGE_MODE, usePowerSync } from './config'
import { LocalStorageAdapter } from './localstorage-adapter'

// Export types and config
export * from './types'
export * from './config'

// Singleton instances
let localStorageAdapter: LocalStorageAdapter | null = null
let powerSyncAdapter: StorageAdapter | null = null

/**
 * Get the configured storage adapter
 *
 * Both adapters sync to backend SQLite:
 * - localStorage: Uses browser localStorage + HTTP sync
 * - PowerSync: Uses SQLite + automatic bi-directional sync
 */
export function getStorageAdapter(): StorageAdapter {
  if (usePowerSync()) {
    if (!powerSyncAdapter) {
      // PowerSync adapter will be implemented in Phase 2
      // For now, fall back to localStorage
      console.warn('[Storage] PowerSync not yet implemented, falling back to localStorage')
      if (!localStorageAdapter) {
        localStorageAdapter = new LocalStorageAdapter()
      }
      return localStorageAdapter
    }
    return powerSyncAdapter
  }

  if (!localStorageAdapter) {
    localStorageAdapter = new LocalStorageAdapter()
  }
  return localStorageAdapter
}

/**
 * Initialize the storage adapter
 * Call this early in the app lifecycle
 */
export async function initializeStorage(): Promise<StorageAdapter> {
  const adapter = getStorageAdapter()
  if (!adapter.isInitialized()) {
    await adapter.initialize()
  }
  return adapter
}

/**
 * Get current storage mode
 */
export function getStorageMode(): typeof STORAGE_MODE {
  return STORAGE_MODE
}

// Re-export the adapter class for testing
export { LocalStorageAdapter }
