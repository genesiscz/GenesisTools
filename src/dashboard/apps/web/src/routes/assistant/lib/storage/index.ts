import type { AssistantStorageAdapter } from './types'
import { AssistantLocalStorageAdapter } from './localstorage-adapter'

// Export types and config
export * from './types'
export * from './config'

// Singleton instance
let storageAdapter: AssistantLocalStorageAdapter | null = null

/**
 * Get the storage adapter singleton
 */
export function getAssistantStorageAdapter(): AssistantStorageAdapter {
  if (!storageAdapter) {
    storageAdapter = new AssistantLocalStorageAdapter()
  }
  return storageAdapter
}

/**
 * Initialize the storage adapter
 * Call this early in the app lifecycle
 */
export async function initializeAssistantStorage(): Promise<AssistantStorageAdapter> {
  const adapter = getAssistantStorageAdapter()
  if (!adapter.isInitialized()) {
    await adapter.initialize()
  }
  return adapter
}

// Re-export adapter class
export { AssistantLocalStorageAdapter }
