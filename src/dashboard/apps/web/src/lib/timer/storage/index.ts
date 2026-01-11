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
 * - localStorage: Uses browser localStorage + HTTP sync (for dev/simple use)
 * - PowerSync: Uses SQLite + automatic bi-directional sync (production)
 */
export function getStorageAdapter(): StorageAdapter {
  if (usePowerSync()) {
    if (!powerSyncAdapter) {
      // Note: PowerSyncAdapter is created lazily in initializeStorage
      // to avoid bundling issues with Vite worker format
      console.warn('[Storage] PowerSync adapter not initialized, falling back to localStorage')
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
  if (usePowerSync() && !powerSyncAdapter) {
    // Dynamic import to avoid Vite worker bundling issues
    const { PowerSyncAdapter } = await import('./powersync-adapter')
    powerSyncAdapter = new PowerSyncAdapter()
  }

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

// Re-export localStorage adapter (PowerSync is dynamically imported)
export { LocalStorageAdapter }
