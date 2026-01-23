/**
 * Server Functions for Claude History Dashboard
 * Using TanStack Start's createServerFn for type-safe server/client data fetching
 */

import { createServerFn } from '@tanstack/react-start'
import {
  getAllConversations,
  searchConversations,
  getConversationBySessionId,
  getConversationStats,
  getConversationStatsWithCache,
  getQuickStatsFromCache,
  getStatsForDateRange,
  getAvailableProjects,
  type SearchFilters,
  type DateRange,
} from '@app/claude-history/lib'

// Serializable types for client/server communication
export interface SerializableConversation {
  filePath: string
  project: string
  sessionId: string
  timestamp: string // ISO string
  summary?: string
  customTitle?: string
  gitBranch?: string
  messageCount: number
  isSubagent: boolean
}

export interface SerializableConversationDetail extends SerializableConversation {
  messages: Array<{
    type: string
    role?: string
    content: string
    timestamp?: string
    toolUses?: Array<{ name: string; input?: object }>
    toolResults?: Array<{ toolUseId: string; content: string; isError?: boolean }>
  }>
}

export interface SerializableStats {
  totalConversations: number
  totalMessages: number
  projectCounts: Record<string, number>
  toolCounts: Record<string, number>
  dailyActivity: Record<string, number>
  hourlyActivity: Record<string, number>
  subagentCount: number
}

// Helper to serialize a conversation result
function serializeResult(result: Awaited<ReturnType<typeof getAllConversations>>[0]): SerializableConversation {
  return {
    filePath: result.filePath,
    project: result.project,
    sessionId: result.sessionId,
    timestamp: result.timestamp.toISOString(),
    summary: result.summary,
    customTitle: result.customTitle,
    gitBranch: result.gitBranch,
    messageCount: result.matchedMessages.length,
    isSubagent: result.isSubagent,
  }
}

// Helper to extract text from a message
function extractMessageContent(msg: { type: string; message?: { content: unknown } }): string {
  if (msg.type === 'user' || msg.type === 'assistant') {
    const content = (msg as { message?: { content: unknown } }).message?.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .filter((b): b is { type: string; text?: string; thinking?: string } =>
          typeof b === 'object' && b !== null && 'type' in b
        )
        .map((b) => {
          if (b.type === 'text') return b.text || ''
          if (b.type === 'thinking') return b.thinking || ''
          // tool_use and tool_result are handled separately - no warning needed
          return ''
        })
        .join('\n')
    }
  }
  if (msg.type === 'summary' && 'summary' in msg) {
    return (msg as { summary: string }).summary
  }
  return ''
}

// Helper to extract tool uses from a message
function extractToolUses(msg: { type: string; message?: { content: unknown } }): Array<{ name: string; input?: object }> {
  if (msg.type !== 'assistant') return []
  const content = (msg as { message?: { content: unknown } }).message?.content
  if (!Array.isArray(content)) return []
  return content
    .filter((b): b is { type: 'tool_use'; name: string; input?: object } =>
      typeof b === 'object' && b !== null && 'type' in b && b.type === 'tool_use'
    )
    .map((b) => ({ name: b.name, input: b.input }))
}

// Helper to extract tool results from a message
function extractToolResults(msg: { type: string; message?: { content: unknown } }): Array<{ toolUseId: string; content: string; isError?: boolean }> {
  if (msg.type !== 'user') return []
  const content = (msg as { message?: { content: unknown } }).message?.content
  if (!Array.isArray(content)) return []
  return content
    .filter((b): b is { type: 'tool_result'; tool_use_id: string; content: string | unknown[]; is_error?: boolean } =>
      typeof b === 'object' && b !== null && 'type' in b && b.type === 'tool_result'
    )
    .map((b) => ({
      toolUseId: b.tool_use_id,
      content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content, null, 2),
      isError: b.is_error,
    }))
}

/**
 * Get conversations with optional search/filtering
 */
export const getConversations = createServerFn({ method: 'GET' })
  .inputValidator((filters: SearchFilters) => filters)
  .handler(async ({ data: filters }) => {
    const results = filters.query
      ? await searchConversations(filters)
      : await getAllConversations({ ...filters, limit: filters.limit || 50 })
    return results.map(serializeResult)
  })

/**
 * Get a single conversation by session ID with full messages
 */
export const getConversation = createServerFn({ method: 'GET' })
  .inputValidator((id: string) => id)
  .handler(async ({ data: id }) => {
    const result = await getConversationBySessionId(id)
    if (!result) return null

    const detail: SerializableConversationDetail = {
      ...serializeResult(result),
      messages: result.matchedMessages.map((msg) => ({
        type: msg.type,
        role: 'message' in msg ? (msg.message as { role?: string })?.role : undefined,
        content: extractMessageContent(msg as { type: string; message?: { content: unknown } }),
        timestamp: 'timestamp' in msg ? String(msg.timestamp) : undefined,
        toolUses: extractToolUses(msg as { type: string; message?: { content: unknown } }),
        toolResults: extractToolResults(msg as { type: string; message?: { content: unknown } }),
      })),
    }
    return detail
  })

/**
 * Get conversation statistics (legacy - full scan)
 */
export const getStats = createServerFn({ method: 'GET' }).handler(async () => {
  const stats = await getConversationStats()
  return stats as SerializableStats
})

/**
 * Get quick stats from cache (instant, for initial page load)
 * Returns cached totals without scanning files
 */
export const getQuickStats = createServerFn({ method: 'GET' }).handler(async () => {
  const cached = getQuickStatsFromCache()

  if (cached) {
    return {
      totalConversations: cached.totalConversations,
      totalMessages: cached.totalMessages,
      subagentCount: cached.subagentCount,
      projectCount: cached.projectCount,
      isCached: true,
    }
  }

  // No cache, compute synchronously (first load)
  const stats = await getConversationStats()
  return {
    totalConversations: stats.totalConversations,
    totalMessages: stats.totalMessages,
    subagentCount: stats.subagentCount,
    projectCount: Object.keys(stats.projectCounts).length,
    isCached: false,
  }
})

export interface QuickStatsResponse {
  totalConversations: number
  totalMessages: number
  subagentCount: number
  projectCount: number
  isCached: boolean
}

/**
 * Get full stats with caching (incremental updates)
 * Optionally filter by date range
 */
export const getFullStats = createServerFn({ method: 'GET' })
  .inputValidator((input: { from?: string; to?: string; forceRefresh?: boolean }) => input)
  .handler(async ({ data }) => {
    const dateRange: DateRange | undefined =
      data.from || data.to ? { from: data.from, to: data.to } : undefined

    const stats = await getConversationStatsWithCache({
      forceRefresh: data.forceRefresh,
      dateRange,
    })

    return stats as SerializableStats
  })

/**
 * Get stats for a specific date range from cache
 */
export const getStatsInRange = createServerFn({ method: 'GET' })
  .inputValidator((input: { from: string; to: string }) => input)
  .handler(async ({ data }) => {
    const stats = await getStatsForDateRange({ from: data.from, to: data.to })
    return stats as SerializableStats
  })

/**
 * Get available projects
 */
export const getProjects = createServerFn({ method: 'GET' }).handler(async () => {
  return getAvailableProjects()
})
