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
  getAvailableProjects,
  type SearchFilters,
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
  }>
}

export interface SerializableStats {
  totalConversations: number
  totalMessages: number
  projectCounts: Record<string, number>
  toolCounts: Record<string, number>
  dailyActivity: Record<string, number>
  subagentCount: number
}

/**
 * Convert an internal conversation result into a client-serializable conversation object.
 *
 * @param result - The raw conversation result returned by data access functions
 * @returns A SerializableConversation where `timestamp` is an ISO string and `messageCount` equals the number of matched messages
 */
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

/**
 * Extracts textual content from a message object for display or serialization.
 *
 * Handles:
 * - user and assistant messages whose `message.content` is a string or an array of content blocks (concatenates `text` and `thinking` blocks with newline separators),
 * - summary messages that provide a `summary` field.
 *
 * @param msg - The message object; may be a user/assistant message with `message.content`, or a summary message with a `summary` field.
 * @returns The extracted text content, or an empty string if no text can be extracted.
 */
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

/**
 * Extracts tool-use entries from an assistant message's content.
 *
 * @param msg - Message object that may contain a `content` array of blocks
 * @returns An array of tool-use descriptors with `name` and optional `input`; an empty array if the message is not an assistant message or contains no tool-use blocks
 */
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
      })),
    }
    return detail
  })

/**
 * Get conversation statistics
 */
export const getStats = createServerFn({ method: 'GET' }).handler(async () => {
  const stats = await getConversationStats()
  return stats as SerializableStats
})

/**
 * Get available projects
 */
export const getProjects = createServerFn({ method: 'GET' }).handler(async () => {
  return getAvailableProjects()
})