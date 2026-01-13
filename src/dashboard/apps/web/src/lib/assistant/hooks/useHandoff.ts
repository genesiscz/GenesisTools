/**
 * Handoff Hook - Server-first with localStorage fallback
 *
 * Uses TanStack Query for server data with refetchOnWindowFocus.
 * Falls back to localStorage when server is unavailable.
 */

import { useState, useEffect, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type {
  HandoffDocument,
  HandoffDocumentInput,
  HandoffDocumentUpdate,
} from '@/lib/assistant/types'
import { generateHandoffId } from '@/lib/assistant/types'
import {
  getAssistantStorageAdapter,
  initializeAssistantStorage,
} from '@/lib/assistant/lib/storage'
import {
  useAssistantHandoffsQuery,
  useCreateAssistantHandoffMutation,
  useUpdateAssistantHandoffMutation,
  assistantKeys,
} from './useAssistantQueries'

/**
 * Hook to manage handoff documents
 * Server-first with localStorage fallback
 */
export function useHandoff(userId: string | null) {
  const queryClient = useQueryClient()
  const [fallbackMode, setFallbackMode] = useState(false)
  const [fallbackHandoffs, setFallbackHandoffs] = useState<HandoffDocument[]>([])
  const [error, setError] = useState<string | null>(null)

  // Server queries
  const handoffsQuery = useAssistantHandoffsQuery(userId)

  // Server mutations
  const createMutation = useCreateAssistantHandoffMutation()
  const updateMutation = useUpdateAssistantHandoffMutation()

  // Determine if we should use fallback mode
  const useFallback = fallbackMode || (handoffsQuery.isError && !handoffsQuery.data)

  // Initialize localStorage fallback if server fails
  useEffect(() => {
    if (!userId) return

    if (handoffsQuery.isError && !fallbackMode) {
      const currentUserId = userId

      async function loadFallback() {
        try {
          const adapter = await initializeAssistantStorage()
          const data = await adapter.getHandoffs(currentUserId)
          setFallbackMode(true)
          setFallbackHandoffs(data)
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to load fallback')
        }
      }

      loadFallback()
    }
  }, [userId, handoffsQuery.isError, fallbackMode])

  // Convert server handoffs to app HandoffDocument type
  const handoffs: HandoffDocument[] = useMemo(() => {
    if (useFallback) return fallbackHandoffs

    return (handoffsQuery.data ?? []).map((h) => ({
      id: h.id,
      userId: h.userId,
      taskId: h.taskId,
      summary: h.summary,
      contextNotes: h.contextNotes,
      nextSteps: (h.nextSteps as string[]) ?? [],
      gotchas: h.gotchas ?? undefined,
      decisions: (h.decisions as string[]) ?? [],
      blockers: (h.blockers as string[]) ?? [],
      handedOffFrom: h.handedOffFrom,
      handedOffTo: h.handedOffTo,
      contact: h.contact,
      reviewed: h.reviewed === 1,
      reviewedAt: h.reviewedAt ? new Date(h.reviewedAt) : undefined,
      handoffAt: new Date(h.handoffAt),
      createdAt: new Date(h.createdAt),
      updatedAt: new Date(h.updatedAt),
    }))
  }, [useFallback, fallbackHandoffs, handoffsQuery.data])

  // Loading state
  const loading = handoffsQuery.isLoading

  /**
   * Create a new handoff document
   */
  async function createHandoff(input: HandoffDocumentInput): Promise<HandoffDocument | null> {
    if (!userId) return null

    const now = new Date()
    const handoffId = generateHandoffId()

    // Input type does not have handedOffFrom or handoffAt - provide defaults
    const handedOffFrom = userId // Default: current user is the one handing off
    const handoffAt = now // Default: handoff happens now

    if (useFallback) {
      try {
        const adapter = getAssistantStorageAdapter()
        const handoff = await adapter.createHandoff(input, userId)
        setFallbackHandoffs((prev) => [handoff, ...prev])
        return handoff
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create handoff')
        return null
      }
    }

    try {
      const result = await createMutation.mutateAsync({
        id: handoffId,
        userId,
        taskId: input.taskId,
        summary: input.summary,
        contextNotes: input.contextNotes,
        nextSteps: input.nextSteps,
        gotchas: input.gotchas ?? null,
        decisions: input.decisions ?? [],
        blockers: input.blockers ?? [],
        handedOffFrom: handedOffFrom,
        handedOffTo: input.handedOffTo,
        contact: input.contact,
        reviewed: 0,
        reviewedAt: null,
        handoffAt: handoffAt.toISOString(),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      })

      if (!result) throw new Error('Failed to create handoff')

      return {
        id: result.id,
        userId,
        taskId: input.taskId,
        summary: input.summary,
        contextNotes: input.contextNotes,
        nextSteps: input.nextSteps,
        gotchas: input.gotchas,
        decisions: input.decisions ?? [],
        blockers: input.blockers ?? [],
        handedOffFrom: handedOffFrom,
        handedOffTo: input.handedOffTo,
        contact: input.contact,
        reviewed: false,
        handoffAt: handoffAt,
        createdAt: now,
        updatedAt: now,
      }
    } catch (err) {
      // Fall back to localStorage on error
      try {
        const adapter = await initializeAssistantStorage()
        const handoff = await adapter.createHandoff(input, userId)
        setFallbackHandoffs((prev) => [handoff, ...prev])
        return handoff
      } catch {
        setError(err instanceof Error ? err.message : 'Failed to create handoff')
        return null
      }
    }
  }

  /**
   * Update an existing handoff document
   */
  async function updateHandoff(
    id: string,
    updates: HandoffDocumentUpdate
  ): Promise<HandoffDocument | null> {
    if (!userId) return null

    // Convert updates for server - HandoffDocumentUpdate does NOT include handedOffTo
    const serverUpdates: Record<string, unknown> = {}
    if (updates.summary !== undefined) serverUpdates.summary = updates.summary
    if (updates.contextNotes !== undefined) serverUpdates.contextNotes = updates.contextNotes
    if (updates.nextSteps !== undefined) serverUpdates.nextSteps = updates.nextSteps
    if (updates.gotchas !== undefined) serverUpdates.gotchas = updates.gotchas
    if (updates.decisions !== undefined) serverUpdates.decisions = updates.decisions
    if (updates.blockers !== undefined) serverUpdates.blockers = updates.blockers
    if (updates.contact !== undefined) serverUpdates.contact = updates.contact
    if (updates.reviewed !== undefined) serverUpdates.reviewed = updates.reviewed ? 1 : 0
    if (updates.reviewedAt !== undefined)
      serverUpdates.reviewedAt = updates.reviewedAt?.toISOString() ?? null

    // Get the existing handoff to find its taskId
    const existingHandoff = handoffs.find((h) => h.id === id)
    if (!existingHandoff) return null

    if (useFallback) {
      // Optimistic update
      setFallbackHandoffs((prev) =>
        prev.map((h) => (h.id === id ? { ...h, ...updates, updatedAt: new Date() } : h))
      )

      try {
        const adapter = getAssistantStorageAdapter()
        return await adapter.updateHandoff(id, updates)
      } catch (err) {
        // Rollback on error
        if (userId) {
          const adapter = getAssistantStorageAdapter()
          const data = await adapter.getHandoffs(userId)
          setFallbackHandoffs(data)
        }
        setError(err instanceof Error ? err.message : 'Failed to update handoff')
        return null
      }
    }

    try {
      const result = await updateMutation.mutateAsync({
        id,
        data: serverUpdates,
        userId,
        taskId: existingHandoff.taskId,
      })
      if (!result) throw new Error('Failed to update handoff')

      return {
        ...existingHandoff,
        ...updates,
        updatedAt: new Date(),
      }
    } catch (err) {
      // Fall back to localStorage
      try {
        const adapter = await initializeAssistantStorage()
        return await adapter.updateHandoff(id, updates)
      } catch {
        setError(err instanceof Error ? err.message : 'Failed to update handoff')
        return null
      }
    }
  }

  /**
   * Acknowledge/review a handoff document
   */
  async function acknowledgeHandoff(id: string): Promise<HandoffDocument | null> {
    return updateHandoff(id, {
      reviewed: true,
      reviewedAt: new Date(),
    })
  }

  /**
   * Delete a handoff document
   */
  async function deleteHandoff(id: string): Promise<boolean> {
    if (useFallback) {
      try {
        const adapter = getAssistantStorageAdapter()
        await adapter.deleteHandoff(id)
        setFallbackHandoffs((prev) => prev.filter((h) => h.id !== id))
        return true
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete handoff')
        return false
      }
    }

    // For server mode, we don't have a delete endpoint, so mark as reviewed
    // This preserves history
    const result = await acknowledgeHandoff(id)
    return result !== null
  }

  /**
   * Get a handoff by ID
   */
  function getHandoff(id: string): HandoffDocument | undefined {
    return handoffs.find((h) => h.id === id)
  }

  /**
   * Get handoffs for a specific task
   */
  function getHandoffsForTask(taskId: string): HandoffDocument[] {
    return handoffs.filter((h) => h.taskId === taskId)
  }

  /**
   * Get pending (unreviewed) handoffs
   */
  function getPendingHandoffs(): HandoffDocument[] {
    return handoffs.filter((h) => !h.reviewed)
  }

  /**
   * Get reviewed handoffs
   */
  function getReviewedHandoffs(): HandoffDocument[] {
    return handoffs.filter((h) => h.reviewed)
  }

  /**
   * Get handoffs I created
   */
  function getMyCreatedHandoffs(): HandoffDocument[] {
    if (!userId) return []
    return handoffs.filter((h) => h.handedOffFrom === userId)
  }

  /**
   * Get handoffs assigned to me
   */
  function getHandoffsAssignedToMe(): HandoffDocument[] {
    if (!userId) return []
    return handoffs.filter((h) => h.handedOffTo === userId)
  }

  /**
   * Get recent handoffs (last N days)
   */
  function getRecentHandoffs(days = 7): HandoffDocument[] {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - days)
    return handoffs.filter((h) => h.handoffAt >= cutoff)
  }

  /**
   * Generate handoff summary markdown
   */
  function generateHandoffMarkdown(handoff: HandoffDocument): string {
    const lines: string[] = [
      `# Handoff: ${handoff.summary}`,
      '',
      `**From:** ${handoff.handedOffFrom}`,
      `**To:** ${handoff.handedOffTo}`,
      `**Date:** ${handoff.handoffAt.toLocaleDateString()}`,
      '',
      '## Context',
      handoff.contextNotes,
      '',
    ]

    if (handoff.nextSteps.length > 0) {
      lines.push('## Next Steps')
      for (const step of handoff.nextSteps) {
        lines.push(`- [ ] ${step}`)
      }
      lines.push('')
    }

    if (handoff.gotchas) {
      lines.push('## Gotchas / Watch Out For')
      lines.push(handoff.gotchas)
      lines.push('')
    }

    if (handoff.decisions.length > 0) {
      lines.push('## Related Decisions')
      lines.push(`Decision IDs: ${handoff.decisions.join(', ')}`)
      lines.push('')
    }

    if (handoff.blockers.length > 0) {
      lines.push('## Active Blockers')
      lines.push(`Blocker IDs: ${handoff.blockers.join(', ')}`)
      lines.push('')
    }

    lines.push('## Contact')
    lines.push(handoff.contact)

    return lines.join('\n')
  }

  /**
   * Clear error
   */
  function clearError() {
    setError(null)
  }

  /**
   * Manual refresh
   */
  function refresh() {
    if (userId) {
      queryClient.invalidateQueries({ queryKey: assistantKeys.handoffList(userId) })
    }
  }

  return {
    // State
    handoffs,
    loading,
    error,

    // CRUD operations
    createHandoff,
    updateHandoff,
    acknowledgeHandoff,
    deleteHandoff,
    getHandoff,

    // Filters
    getHandoffsForTask,
    getPendingHandoffs,
    getReviewedHandoffs,
    getMyCreatedHandoffs,
    getHandoffsAssignedToMe,
    getRecentHandoffs,

    // Utilities
    generateHandoffMarkdown,
    clearError,
    refresh,

    // Server status
    isServerMode: !useFallback,
  }
}
