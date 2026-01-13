import { EventEmitter } from 'events'

/**
 * Global event emitter for all features
 *
 * This single emitter handles all real-time events across the entire application.
 * Each feature subscribes to specific channels based on patterns.
 */
const globalEventEmitter = new EventEmitter()

// Support many concurrent connections (default is 10)
globalEventEmitter.setMaxListeners(100)

/**
 * Get the global event emitter (used by SSE endpoint)
 */
export function getEventEmitter(): EventEmitter {
  return globalEventEmitter
}

/**
 * Broadcast an event to a specific channel
 *
 * @param channel - Channel name (e.g., 'timer:user123', 'chat:room456')
 * @param data - Data to broadcast
 *
 * @example
 * ```ts
 * broadcast('timer:user123', { type: 'sync', timestamp: Date.now() })
 * ```
 */
export function broadcast(channel: string, data: unknown): void {
  console.log(`[Events] Broadcasting to channel: ${channel}`)
  globalEventEmitter.emit(channel, data)
}

/**
 * Broadcast to a user-specific feature channel
 *
 * Pattern: `{feature}:{userId}`
 *
 * @example
 * ```ts
 * broadcastToUser('timer', 'user123', { type: 'sync' })
 * // Broadcasts to channel: timer:user123
 * ```
 */
export function broadcastToUser(feature: string, userId: string, data: unknown): void {
  broadcast(`${feature}:${userId}`, data)
}

/**
 * Broadcast to a scoped channel (e.g., chat room, project, team)
 *
 * Pattern: `{feature}:{scope}:{id}`
 *
 * @example
 * ```ts
 * broadcastToScope('chat', 'room', 'room456', { message: 'Hello' })
 * // Broadcasts to channel: chat:room:room456
 * ```
 */
export function broadcastToScope(feature: string, scope: string, id: string, data: unknown): void {
  broadcast(`${feature}:${scope}:${id}`, data)
}

/**
 * Broadcast to all users of a feature
 *
 * Pattern: `{feature}:*`
 *
 * @example
 * ```ts
 * broadcastToFeature('notification', { type: 'system_update' })
 * // Broadcasts to channel: notification:*
 * ```
 */
export function broadcastToFeature(feature: string, data: unknown): void {
  broadcast(`${feature}:*`, data)
}
