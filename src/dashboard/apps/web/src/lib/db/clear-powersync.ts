/**
 * Clear PowerSync IndexedDB database
 * Use this when database is corrupted or stuck
 */
export async function clearPowerSyncDatabase(): Promise<void> {
  if (typeof window === 'undefined') {
    console.log('[PowerSync] Skipping clear on server')
    return
  }

  try {
    console.log('[PowerSync] Deleting IndexedDB database: dashboard.sqlite')

    // Delete the main PowerSync database
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('dashboard.sqlite')

      request.onsuccess = () => {
        console.log('[PowerSync] ✓ Deleted dashboard.sqlite')
        resolve()
      }

      request.onerror = () => {
        console.error('[PowerSync] ✗ Failed to delete dashboard.sqlite:', request.error)
        reject(request.error)
      }

      request.onblocked = () => {
        console.warn('[PowerSync] Delete blocked - close all tabs and try again')
        reject(new Error('Database delete blocked'))
      }
    })

    // Also try to delete any PowerSync-related databases
    const databases = await indexedDB.databases()
    for (const dbInfo of databases) {
      if (dbInfo.name?.includes('powersync') || dbInfo.name?.includes('dashboard')) {
        console.log(`[PowerSync] Deleting ${dbInfo.name}`)
        await new Promise<void>((resolve) => {
          const request = indexedDB.deleteDatabase(dbInfo.name!)
          request.onsuccess = () => resolve()
          request.onerror = () => resolve() // Continue even if fails
        })
      }
    }

    console.log('[PowerSync] ✓ All databases cleared')
    console.log('[PowerSync] 🔄 Please refresh the page')
  } catch (err) {
    console.error('[PowerSync] Clear failed:', err)
    throw err
  }
}

// Expose globally for easy access from console
if (typeof window !== 'undefined') {
  ;(window as any).clearPowerSyncDB = clearPowerSyncDatabase
}
