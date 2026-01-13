import { useState, useEffect } from 'react'
import type {
  HandoffDocument,
  HandoffDocumentInput,
  HandoffDocumentUpdate,
} from '@/lib/assistant/types'
import {
  getAssistantStorageAdapter,
  initializeAssistantStorage,
} from '@/lib/assistant/lib/storage'

/**
 * Hook to manage handoff documents
 * Provides create/update/acknowledge functionality
 */
export function useHandoff(userId: string | null) {
  const [handoffs, setHandoffs] = useState<HandoffDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Load handoffs on mount
  useEffect(() => {
    if (!userId) {
      setHandoffs([])
      setLoading(false)
      return
    }

    let mounted = true
    const currentUserId = userId

    async function load() {
      setLoading(true)
      try {
        await initializeAssistantStorage()
        const adapter = getAssistantStorageAdapter()
        const data = await adapter.getHandoffs(currentUserId)
        if (mounted) {
          setHandoffs(data)
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to load handoffs')
        }
      } finally {
        if (mounted) {
          setLoading(false)
        }
      }
    }

    load()

    return () => {
      mounted = false
    }
  }, [userId])

  /**
   * Create a new handoff document
   */
  async function createHandoff(input: HandoffDocumentInput): Promise<HandoffDocument | null> {
    if (!userId) return null

    try {
      const adapter = getAssistantStorageAdapter()
      const handoff = await adapter.createHandoff(input, userId)

      // Add to local state
      setHandoffs((prev) => [handoff, ...prev])

      return handoff
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create handoff')
      return null
    }
  }

  /**
   * Update an existing handoff document
   */
  async function updateHandoff(
    id: string,
    updates: HandoffDocumentUpdate
  ): Promise<HandoffDocument | null> {
    // Optimistic update
    setHandoffs((prev) =>
      prev.map((h) => (h.id === id ? { ...h, ...updates, updatedAt: new Date() } : h))
    )

    try {
      const adapter = getAssistantStorageAdapter()
      const handoff = await adapter.updateHandoff(id, updates)
      return handoff
    } catch (err) {
      // Rollback on error
      if (userId) {
        const adapter = getAssistantStorageAdapter()
        const data = await adapter.getHandoffs(userId)
        setHandoffs(data)
      }
      setError(err instanceof Error ? err.message : 'Failed to update handoff')
      return null
    }
  }

  /**
   * Acknowledge/review a handoff document
   */
  async function acknowledgeHandoff(id: string): Promise<HandoffDocument | null> {
    try {
      const adapter = getAssistantStorageAdapter()
      const handoff = await adapter.acknowledgeHandoff(id)

      // Update local state
      setHandoffs((prev) => prev.map((h) => (h.id === id ? handoff : h)))

      return handoff
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to acknowledge handoff')
      return null
    }
  }

  /**
   * Delete a handoff document
   */
  async function deleteHandoff(id: string): Promise<boolean> {
    try {
      const adapter = getAssistantStorageAdapter()
      await adapter.deleteHandoff(id)

      // Remove from local state
      setHandoffs((prev) => prev.filter((h) => h.id !== id))

      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete handoff')
      return false
    }
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
    return handoffs.filter((h) => new Date(h.handoffAt) >= cutoff)
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
      `**Date:** ${new Date(handoff.handoffAt).toLocaleDateString()}`,
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
  }
}
