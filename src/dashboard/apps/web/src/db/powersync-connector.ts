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
 * 2. uploadData() sends batch to /api/sync/upload
 * 3. Nitro applies changes to server SQLite
 */
export class DashboardConnector implements PowerSyncBackendConnector {
  private apiUrl: string

  constructor(apiUrl: string = '') {
    this.apiUrl = apiUrl
  }

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
   * Called by PowerSync when there are pending local changes.
   * Sends CRUD batch to /api/sync/upload endpoint.
   */
  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    // Get pending CRUD operations
    const batch = await database.getCrudBatch(100)

    if (!batch || batch.crud.length === 0) {
      return
    }

    try {
      const response = await fetch(`${this.apiUrl}/api/sync/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          operations: batch.crud.map((op) => ({
            id: op.id,
            op: op.op,
            table: op.table,
            data: op.opData,
          })),
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Upload failed: ${response.status} - ${errorText}`)
      }

      // Mark the batch as complete
      await batch.complete()
      console.log(`[PowerSync] Uploaded ${batch.crud.length} operations to server`)
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
