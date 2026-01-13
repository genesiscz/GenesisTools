import { Store } from '@tanstack/store'
import { useStore } from '@tanstack/react-store'
import { useEffect, useRef } from 'react'
import type {
  CommunicationEntry,
  CommunicationEntryInput,
  CommunicationEntryUpdate,
} from '@/lib/assistant/types'
import { getAssistantStorageAdapter, initializeAssistantStorage } from '@/lib/assistant/lib/storage'
import type { CommunicationQueryOptions } from '@/lib/assistant/lib/storage/types'

/**
 * Communication log store state
 */
interface CommunicationStoreState {
  entries: CommunicationEntry[]
  loading: boolean
  error: string | null
  initialized: boolean
}

/**
 * Create the communication store
 */
export const communicationStore = new Store<CommunicationStoreState>({
  entries: [],
  loading: false,
  error: null,
  initialized: false,
})

/**
 * Hook to manage communication log entries
 * Provides CRUD operations with cross-tab sync
 */
export function useCommunicationLog(userId: string | null) {
  const state = useStore(communicationStore)
  const unsubscribeRef = useRef<(() => void) | null>(null)

  // Initialize storage and subscribe to updates
  useEffect(() => {
    if (!userId) return

    let mounted = true

    async function init() {
      communicationStore.setState((s) => ({ ...s, loading: true }))

      try {
        const adapter = await initializeAssistantStorage()

        // Initial load
        const entries = await adapter.getCommunicationEntries(userId)

        if (mounted) {
          communicationStore.setState((s) => ({
            ...s,
            entries,
            loading: false,
            initialized: true,
          }))
        }

        // Subscribe to updates
        unsubscribeRef.current = adapter.watchCommunications(userId, (updatedEntries) => {
          if (mounted) {
            communicationStore.setState((s) => ({ ...s, entries: updatedEntries }))
          }
        })
      } catch (err) {
        if (mounted) {
          communicationStore.setState((s) => ({
            ...s,
            error: err instanceof Error ? err.message : 'Failed to initialize communication log',
            loading: false,
          }))
        }
      }
    }

    init()

    return () => {
      mounted = false
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
      }
    }
  }, [userId])

  /**
   * Create a new communication entry
   */
  async function createEntry(input: CommunicationEntryInput): Promise<CommunicationEntry | null> {
    if (!userId) return null

    try {
      const adapter = getAssistantStorageAdapter()
      const entry = await adapter.createCommunicationEntry(input, userId)
      return entry
    } catch (err) {
      communicationStore.setState((s) => ({
        ...s,
        error: err instanceof Error ? err.message : 'Failed to create communication entry',
      }))
      return null
    }
  }

  /**
   * Update an existing communication entry
   */
  async function updateEntry(
    id: string,
    updates: CommunicationEntryUpdate
  ): Promise<CommunicationEntry | null> {
    // Optimistic update
    communicationStore.setState((s) => ({
      ...s,
      entries: s.entries.map((e) =>
        e.id === id ? { ...e, ...updates, updatedAt: new Date() } : e
      ),
    }))

    try {
      const adapter = getAssistantStorageAdapter()
      const entry = await adapter.updateCommunicationEntry(id, updates)
      return entry
    } catch (err) {
      // Rollback on error
      if (userId) {
        const adapter = getAssistantStorageAdapter()
        const entries = await adapter.getCommunicationEntries(userId)
        communicationStore.setState((s) => ({
          ...s,
          entries,
          error: err instanceof Error ? err.message : 'Failed to update communication entry',
        }))
      }
      return null
    }
  }

  /**
   * Delete a communication entry
   */
  async function deleteEntry(id: string): Promise<boolean> {
    try {
      const adapter = getAssistantStorageAdapter()
      await adapter.deleteCommunicationEntry(id)
      return true
    } catch (err) {
      communicationStore.setState((s) => ({
        ...s,
        error: err instanceof Error ? err.message : 'Failed to delete communication entry',
      }))
      return false
    }
  }

  /**
   * Get an entry by ID
   */
  function getEntry(id: string): CommunicationEntry | undefined {
    return state.entries.find((e) => e.id === id)
  }

  /**
   * Query entries with filters
   */
  async function queryEntries(options: CommunicationQueryOptions): Promise<CommunicationEntry[]> {
    if (!userId) return []

    try {
      const adapter = getAssistantStorageAdapter()
      return await adapter.getCommunicationEntries(userId, options)
    } catch {
      return []
    }
  }

  /**
   * Get entries by source
   */
  function getBySource(source: CommunicationEntry['source']): CommunicationEntry[] {
    return state.entries.filter((e) => e.source === source)
  }

  /**
   * Get entries by sentiment
   */
  function getBySentiment(sentiment: CommunicationEntry['sentiment']): CommunicationEntry[] {
    return state.entries.filter((e) => e.sentiment === sentiment)
  }

  /**
   * Get entries related to a task
   */
  function getByTaskId(taskId: string): CommunicationEntry[] {
    return state.entries.filter((e) => e.relatedTaskIds.includes(taskId))
  }

  /**
   * Get entries with a specific tag
   */
  function getByTag(tag: string): CommunicationEntry[] {
    return state.entries.filter((e) => e.tags.includes(tag))
  }

  /**
   * Get all unique tags
   */
  function getAllTags(): string[] {
    const tagSet = new Set<string>()
    for (const entry of state.entries) {
      for (const tag of entry.tags) {
        tagSet.add(tag)
      }
    }
    return Array.from(tagSet).sort()
  }

  /**
   * Get recent entries (last 7 days)
   */
  function getRecentEntries(days = 7): CommunicationEntry[] {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - days)
    return state.entries.filter((e) => new Date(e.discussedAt) >= cutoff)
  }

  /**
   * Clear error
   */
  function clearError() {
    communicationStore.setState((s) => ({ ...s, error: null }))
  }

  return {
    // State
    entries: state.entries,
    loading: state.loading,
    error: state.error,
    initialized: state.initialized,

    // CRUD operations
    createEntry,
    updateEntry,
    deleteEntry,
    getEntry,
    queryEntries,

    // Filters
    getBySource,
    getBySentiment,
    getByTaskId,
    getByTag,
    getAllTags,
    getRecentEntries,

    // Utilities
    clearError,
  }
}
