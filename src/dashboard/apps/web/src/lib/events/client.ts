/**
 * Generic SSE client for subscribing to real-time events
 *
 * This client manages a persistent connection to the /api/events endpoint
 * and allows subscribing to multiple channels simultaneously.
 *
 * Features:
 * - Auto-reconnection (built into EventSource)
 * - Multiple channel subscriptions
 * - Handler registration/unregistration
 * - Singleton pattern for application-wide use
 *
 * @example
 * ```ts
 * const client = getEventClient()
 * client.connect('user123', ['timer:user123', 'notification:user123'])
 *
 * const unsubscribe = client.subscribe('timer:user123', (data) => {
 *   console.log('Timer update:', data)
 * })
 *
 * // Later: unsubscribe()
 * // Or: client.disconnect()
 * ```
 */
export class EventStreamClient {
  private eventSource: EventSource | null = null
  private handlers: Map<string, Set<(data: unknown) => void>> = new Map()
  private userId: string | null = null
  private channels: string[] = []

  /**
   * Connect to the event stream
   *
   * @param userId - User ID (required)
   * @param channels - List of channels to subscribe to (optional)
   *
   * If no channels provided, defaults to common channels for the user.
   *
   * @example
   * ```ts
   * // Subscribe to specific channels
   * client.connect('user123', ['timer:user123', 'chat:room456'])
   *
   * // Or use defaults
   * client.connect('user123')
   * ```
   */
  connect(userId: string, channels?: string[]): void {
    // Close existing connection
    this.disconnect()

    this.userId = userId
    this.channels = channels || []

    const channelsParam = this.channels.length > 0
      ? `&channels=${this.channels.join(',')}`
      : ''

    const url = `/api/events?userId=${userId}${channelsParam}`
    console.log(`[EventClient] Connecting to ${url}`)

    this.eventSource = new EventSource(url)

    this.eventSource.onopen = () => {
      console.log('[EventClient] Connected')
    }

    this.eventSource.onmessage = (event) => {
      const message = JSON.parse(event.data)

      // Handle connection confirmation
      if (message.type === 'connected') {
        console.log('[EventClient] Connection confirmed:', message)
        return
      }

      // Handle channel events
      const { channel, data } = message
      console.log(`[EventClient] 📩 Message received on channel "${channel}":`, data)

      const handlers = this.handlers.get(channel)

      if (handlers) {
        console.log(`[EventClient] Found ${handlers.size} handlers for channel "${channel}"`)
        handlers.forEach(handler => {
          try {
            handler(data)
          } catch (error) {
            console.error(`[EventClient] Handler error for channel ${channel}:`, error)
          }
        })
      } else {
        console.warn(`[EventClient] No handlers registered for channel "${channel}"`)
      }
    }

    this.eventSource.onerror = (error) => {
      console.error('[EventClient] Connection error:', error)
      // Browser will automatically attempt to reconnect
    }
  }

  /**
   * Subscribe to a channel
   *
   * @param channel - Channel name
   * @param handler - Handler function
   * @returns Unsubscribe function
   *
   * @example
   * ```ts
   * const unsubscribe = client.subscribe('timer:user123', (data) => {
   *   console.log('Event:', data)
   * })
   *
   * // Later:
   * unsubscribe()
   * ```
   */
  subscribe(channel: string, handler: (data: unknown) => void): () => void {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set())
    }
    this.handlers.get(channel)!.add(handler)

    console.log(`[EventClient] Subscribed to channel: ${channel}`)

    // Return unsubscribe function
    return () => this.unsubscribe(channel, handler)
  }

  /**
   * Unsubscribe from a channel
   *
   * @param channel - Channel name
   * @param handler - Handler function to remove
   */
  unsubscribe(channel: string, handler: (data: unknown) => void): void {
    const handlers = this.handlers.get(channel)
    if (handlers) {
      handlers.delete(handler)
      console.log(`[EventClient] Unsubscribed from channel: ${channel}`)

      // Clean up empty handler sets
      if (handlers.size === 0) {
        this.handlers.delete(channel)
      }
    }
  }

  /**
   * Disconnect from the event stream
   *
   * Closes the SSE connection and clears all handlers.
   */
  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close()
      this.eventSource = null
      this.handlers.clear()
      this.userId = null
      this.channels = []
      console.log('[EventClient] Disconnected')
    }
  }

  /**
   * Check if connected
   *
   * @returns true if connected and ready
   */
  isConnected(): boolean {
    return this.eventSource !== null && this.eventSource.readyState === EventSource.OPEN
  }

  /**
   * Get current user ID
   */
  getUserId(): string | null {
    return this.userId
  }

  /**
   * Get subscribed channels
   */
  getChannels(): string[] {
    return [...this.channels]
  }
}

/**
 * Singleton instance for application-wide use
 */
let eventClient: EventStreamClient | null = null

/**
 * Get or create the global event client
 *
 * This ensures a single SSE connection is shared across the entire application.
 *
 * @example
 * ```ts
 * const client = getEventClient()
 * client.connect('user123', ['timer:user123'])
 * ```
 */
export function getEventClient(): EventStreamClient {
  if (!eventClient) {
    eventClient = new EventStreamClient()
  }
  return eventClient
}
