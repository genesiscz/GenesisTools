import { Store } from '@tanstack/store'
import { useStore } from '@tanstack/react-store'
import { useEffect, useRef } from 'react'
import type { Decision, DecisionInput, DecisionUpdate } from '@/lib/assistant/types'
import { getAssistantStorageAdapter, initializeAssistantStorage } from '@/lib/assistant/lib/storage'
import type { DecisionQueryOptions } from '@/lib/assistant/lib/storage/types'

/**
 * Decision log store state
 */
interface DecisionStoreState {
  decisions: Decision[]
  loading: boolean
  error: string | null
  initialized: boolean
}

/**
 * Create the decision store
 */
export const decisionStore = new Store<DecisionStoreState>({
  decisions: [],
  loading: false,
  error: null,
  initialized: false,
})

/**
 * Hook to manage decision log entries
 * Provides CRUD operations plus supersede/reverse functionality
 */
export function useDecisionLog(userId: string | null) {
  const state = useStore(decisionStore)
  const unsubscribeRef = useRef<(() => void) | null>(null)

  // Initialize storage and subscribe to updates
  useEffect(() => {
    if (!userId) return

    let mounted = true

    async function init() {
      decisionStore.setState((s) => ({ ...s, loading: true }))

      try {
        const adapter = await initializeAssistantStorage()

        // Initial load
        const decisions = await adapter.getDecisions(userId)

        if (mounted) {
          decisionStore.setState((s) => ({
            ...s,
            decisions,
            loading: false,
            initialized: true,
          }))
        }

        // Subscribe to updates
        unsubscribeRef.current = adapter.watchDecisions(userId, (updatedDecisions) => {
          if (mounted) {
            decisionStore.setState((s) => ({ ...s, decisions: updatedDecisions }))
          }
        })
      } catch (err) {
        if (mounted) {
          decisionStore.setState((s) => ({
            ...s,
            error: err instanceof Error ? err.message : 'Failed to initialize decision log',
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
   * Create a new decision
   */
  async function createDecision(input: DecisionInput): Promise<Decision | null> {
    if (!userId) return null

    try {
      const adapter = getAssistantStorageAdapter()
      const decision = await adapter.createDecision(input, userId)
      return decision
    } catch (err) {
      decisionStore.setState((s) => ({
        ...s,
        error: err instanceof Error ? err.message : 'Failed to create decision',
      }))
      return null
    }
  }

  /**
   * Update an existing decision
   */
  async function updateDecision(id: string, updates: DecisionUpdate): Promise<Decision | null> {
    // Optimistic update
    decisionStore.setState((s) => ({
      ...s,
      decisions: s.decisions.map((d) =>
        d.id === id ? { ...d, ...updates, updatedAt: new Date() } : d
      ),
    }))

    try {
      const adapter = getAssistantStorageAdapter()
      const decision = await adapter.updateDecision(id, updates)
      return decision
    } catch (err) {
      // Rollback on error
      if (userId) {
        const adapter = getAssistantStorageAdapter()
        const decisions = await adapter.getDecisions(userId)
        decisionStore.setState((s) => ({
          ...s,
          decisions,
          error: err instanceof Error ? err.message : 'Failed to update decision',
        }))
      }
      return null
    }
  }

  /**
   * Delete a decision
   */
  async function deleteDecision(id: string): Promise<boolean> {
    try {
      const adapter = getAssistantStorageAdapter()
      await adapter.deleteDecision(id)
      return true
    } catch (err) {
      decisionStore.setState((s) => ({
        ...s,
        error: err instanceof Error ? err.message : 'Failed to delete decision',
      }))
      return false
    }
  }

  /**
   * Supersede a decision with a new one
   * @param oldDecisionId The decision being superseded
   * @param newDecision The new decision replacing it
   */
  async function supersedeDecision(
    oldDecisionId: string,
    newDecision: DecisionInput
  ): Promise<{ oldDecision: Decision; newDecision: Decision } | null> {
    if (!userId) return null

    try {
      const adapter = getAssistantStorageAdapter()

      // Create new decision first
      const newDec = await adapter.createDecision(newDecision, userId)

      // Mark old decision as superseded
      const oldDec = await adapter.supersedeDecision(oldDecisionId, newDec.id)

      return { oldDecision: oldDec, newDecision: newDec }
    } catch (err) {
      decisionStore.setState((s) => ({
        ...s,
        error: err instanceof Error ? err.message : 'Failed to supersede decision',
      }))
      return null
    }
  }

  /**
   * Reverse a decision
   * @param id The decision to reverse
   * @param reason Why the decision is being reversed
   */
  async function reverseDecision(id: string, reason: string): Promise<Decision | null> {
    try {
      const adapter = getAssistantStorageAdapter()
      const decision = await adapter.reverseDecision(id, reason)
      return decision
    } catch (err) {
      decisionStore.setState((s) => ({
        ...s,
        error: err instanceof Error ? err.message : 'Failed to reverse decision',
      }))
      return null
    }
  }

  /**
   * Get a decision by ID
   */
  function getDecision(id: string): Decision | undefined {
    return state.decisions.find((d) => d.id === id)
  }

  /**
   * Query decisions with filters
   */
  async function queryDecisions(options: DecisionQueryOptions): Promise<Decision[]> {
    if (!userId) return []

    try {
      const adapter = getAssistantStorageAdapter()
      return await adapter.getDecisions(userId, options)
    } catch {
      return []
    }
  }

  /**
   * Get active decisions only
   */
  function getActiveDecisions(): Decision[] {
    return state.decisions.filter((d) => d.status === 'active')
  }

  /**
   * Get superseded decisions
   */
  function getSupersededDecisions(): Decision[] {
    return state.decisions.filter((d) => d.status === 'superseded')
  }

  /**
   * Get reversed decisions
   */
  function getReversedDecisions(): Decision[] {
    return state.decisions.filter((d) => d.status === 'reversed')
  }

  /**
   * Get decisions by impact area
   */
  function getByImpactArea(impactArea: Decision['impactArea']): Decision[] {
    return state.decisions.filter((d) => d.impactArea === impactArea)
  }

  /**
   * Get decisions related to a task
   */
  function getByTaskId(taskId: string): Decision[] {
    return state.decisions.filter((d) => d.relatedTaskIds.includes(taskId))
  }

  /**
   * Get decisions with a specific tag
   */
  function getByTag(tag: string): Decision[] {
    return state.decisions.filter((d) => d.tags.includes(tag))
  }

  /**
   * Get decision that superseded another
   */
  function getSupersedingDecision(decisionId: string): Decision | undefined {
    const decision = state.decisions.find((d) => d.id === decisionId)
    if (decision?.supersededBy) {
      return state.decisions.find((d) => d.id === decision.supersededBy)
    }
    return undefined
  }

  /**
   * Get decision chain (original -> superseding -> etc)
   */
  function getDecisionChain(decisionId: string): Decision[] {
    const chain: Decision[] = []
    let current = state.decisions.find((d) => d.id === decisionId)

    while (current) {
      chain.push(current)
      if (current.supersededBy) {
        current = state.decisions.find((d) => d.id === current!.supersededBy)
      } else {
        break
      }
    }

    return chain
  }

  /**
   * Get all unique tags
   */
  function getAllTags(): string[] {
    const tagSet = new Set<string>()
    for (const decision of state.decisions) {
      for (const tag of decision.tags) {
        tagSet.add(tag)
      }
    }
    return Array.from(tagSet).sort()
  }

  /**
   * Get recent decisions (last N days)
   */
  function getRecentDecisions(days = 30): Decision[] {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - days)
    return state.decisions.filter((d) => new Date(d.decidedAt) >= cutoff)
  }

  /**
   * Clear error
   */
  function clearError() {
    decisionStore.setState((s) => ({ ...s, error: null }))
  }

  return {
    // State
    decisions: state.decisions,
    loading: state.loading,
    error: state.error,
    initialized: state.initialized,

    // CRUD operations
    createDecision,
    updateDecision,
    deleteDecision,
    getDecision,
    queryDecisions,

    // Supersede/Reverse
    supersedeDecision,
    reverseDecision,

    // Filters
    getActiveDecisions,
    getSupersededDecisions,
    getReversedDecisions,
    getByImpactArea,
    getByTaskId,
    getByTag,
    getSupersedingDecision,
    getDecisionChain,
    getAllTags,
    getRecentDecisions,

    // Utilities
    clearError,
  }
}
