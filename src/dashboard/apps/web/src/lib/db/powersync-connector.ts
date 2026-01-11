import type {
  AbstractPowerSyncDatabase,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
} from '@powersync/web'

/**
 * Dashboard PowerSync Backend Connector
 *
 * This connector handles uploading local changes to the Nitro backend.
 * Runs in "local-only" mode - no PowerSync Cloud, just client SQLite + server SQLite.
 *
 * Flow:
 * 1. Client makes changes → PowerSync queues in CRUD batch
 * 2. uploadData() calls server function to sync
 * 3. Nitro applies changes to server SQLite
 */
export class DashboardConnector implements PowerSyncBackendConnector {
  /**
   * Fetch PowerSync credentials
   *
   * For local-only mode (no PowerSync Cloud), return null.
   * This disables the PowerSync sync service connection.
   */
  async fetchCredentials(): Promise<PowerSyncCredentials | null> {
    // Local-only mode - no PowerSync Cloud
    // Return null to disable sync service connection
    return null
  }

  /**
   * Upload local changes to the Nitro backend
   *
   * Called manually after write operations.
   * Uses TanStack Start server function for RPC.
   */
  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    // Get pending CRUD operations
    const batch = await database.getCrudBatch(100)

    if (!batch || batch.crud.length === 0) {
      console.log('[PowerSync] No pending operations to sync')
      return
    }

    try {
      const operations = batch.crud.map((op) => ({
        id: op.id,
        op: op.op as 'PUT' | 'PATCH' | 'DELETE',
        table: op.table,
        data: op.opData as Record<string, unknown>,
      }))

      console.log(`[PowerSync] Uploading ${operations.length} operations to server...`)

      // Dynamic import to avoid bundling issues
      const { uploadSyncBatch } = await import('@/lib/timer-sync.server')
      await uploadSyncBatch({ data: { operations } })

      // Mark the batch as complete
      await batch.complete()
      console.log(`[PowerSync] Uploaded ${operations.length} operations to server`)
    } catch (error) {
      console.error('[PowerSync] Error uploading data:', error)
      throw error // Rethrow to trigger retry
    }
  }
}

/**
 * Create a connector instance
 */
export function createConnector(): DashboardConnector {
  return new DashboardConnector()
}
