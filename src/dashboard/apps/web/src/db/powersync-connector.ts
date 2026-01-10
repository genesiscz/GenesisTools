import type {
  AbstractPowerSyncDatabase,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
} from '@powersync/web'

/**
 * Dashboard PowerSync Backend Connector
 *
 * This connector handles:
 * 1. Authentication - Gets credentials from WorkOS session
 * 2. Data upload - Sends local changes to the Nitro server
 *
 * The connector is required for bi-directional sync with the backend.
 */
export class DashboardConnector implements PowerSyncBackendConnector {
  private apiUrl: string

  constructor(apiUrl: string = '/api') {
    this.apiUrl = apiUrl
  }

  /**
   * Fetch PowerSync credentials from the backend
   *
   * This exchanges the WorkOS session for PowerSync-compatible credentials.
   * The backend validates the session and returns a JWT for PowerSync.
   */
  async fetchCredentials(): Promise<PowerSyncCredentials | null> {
    try {
      const response = await fetch(`${this.apiUrl}/auth/powersync-token`, {
        credentials: 'include', // Include cookies for session auth
      })

      if (!response.ok) {
        console.error('Failed to fetch PowerSync credentials:', response.status)
        return null
      }

      const data = await response.json()
      return {
        endpoint: data.endpoint,
        token: data.token,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
      }
    } catch (error) {
      console.error('Error fetching PowerSync credentials:', error)
      return null
    }
  }

  /**
   * Upload local changes to the backend
   *
   * This is called by PowerSync when there are pending local changes
   * that need to be synced to the server.
   */
  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    // Get pending CRUD operations
    const batch = await database.getCrudBatch(100)

    if (!batch || batch.crud.length === 0) {
      return
    }

    try {
      const response = await fetch(`${this.apiUrl}/sync/upload`, {
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
        throw new Error(`Upload failed: ${response.status}`)
      }

      // Mark the batch as complete
      await batch.complete()
    } catch (error) {
      console.error('Error uploading data:', error)
      throw error // Rethrow to trigger retry
    }
  }
}

/**
 * Create a connector instance with the configured API URL
 */
export function createConnector(): DashboardConnector {
  const apiUrl = import.meta.env.VITE_API_URL || '/api'
  return new DashboardConnector(apiUrl)
}
