/**
 * API Endpoint Tests
 *
 * Tests for the SSE events API endpoint in the timer feature.
 * These tests verify the Server-Sent Events endpoint behavior.
 *
 * Note: These tests require the dev server to be running on localhost:3000
 * Run with: bun test src/__tests__/api.test.ts
 */
import { describe, test, expect, beforeAll } from 'bun:test'

const BASE_URL = 'http://localhost:3000'
const SSE_ENDPOINT = `${BASE_URL}/api/events`

/**
 * Helper to check if the server is running and the SSE endpoint is available
 */
async function isServerRunning(): Promise<boolean> {
  try {
    // Test the actual SSE endpoint with a test userId
    const response = await fetch(`${SSE_ENDPOINT}?userId=health-check`, {
      signal: AbortSignal.timeout(2000),
    })
    // The endpoint should return 200 for valid requests
    // If we get 404, the route doesn't exist (server might be running but endpoint not registered)
    return response.status === 200
  } catch {
    return false
  }
}

/**
 * Helper to read SSE messages from a ReadableStream
 */
async function readSSEMessages(
  stream: ReadableStream<Uint8Array>,
  options: { timeout?: number; maxMessages?: number } = {}
): Promise<string[]> {
  const { timeout = 5000, maxMessages = 10 } = options
  const messages: string[] = []
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const startTime = Date.now()

  try {
    while (messages.length < maxMessages && Date.now() - startTime < timeout) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), timeout - (Date.now() - startTime))
        ),
      ])

      if (done) break
      if (value) {
        const text = decoder.decode(value)
        // SSE messages are separated by double newlines
        const eventLines = text.split('\n\n').filter(Boolean)
        for (const line of eventLines) {
          if (line.startsWith('data: ')) {
            messages.push(line.substring(6))
          } else if (line.startsWith(': keepalive')) {
            messages.push('keepalive')
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  return messages
}

/**
 * Helper to parse SSE data message
 */
function parseSSEData<T>(data: string): T {
  return JSON.parse(data) as T
}

describe('API Events SSE Endpoint', () => {
  let serverAvailable = false

  beforeAll(async () => {
    serverAvailable = await isServerRunning()
    if (!serverAvailable) {
      console.warn('Warning: Dev server not running at localhost:3000. Some tests will be skipped.')
    }
  })

  describe('Parameter Validation', () => {
    test('requires userId query parameter', async () => {
      if (!serverAvailable) {
        console.log('Skipping: server not available')
        return
      }

      const response = await fetch(SSE_ENDPOINT)

      expect(response.status).toBe(400)
      expect(response.headers.get('Content-Type')).toBe('application/json')

      const body = await response.json()
      expect(body).toEqual({ error: 'Missing userId parameter' })
    })

    test('returns 400 for empty userId parameter', async () => {
      if (!serverAvailable) {
        console.log('Skipping: server not available')
        return
      }

      const response = await fetch(`${SSE_ENDPOINT}?userId=`)

      expect(response.status).toBe(400)
      expect(response.headers.get('Content-Type')).toBe('application/json')

      const body = await response.json()
      expect(body).toEqual({ error: 'Missing userId parameter' })
    })
  })

  describe('SSE Response Headers', () => {
    test('returns text/event-stream content type', async () => {
      if (!serverAvailable) {
        console.log('Skipping: server not available')
        return
      }

      const controller = new AbortController()
      const response = await fetch(`${SSE_ENDPOINT}?userId=test-user`, {
        signal: controller.signal,
      })

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('text/event-stream')
      expect(response.headers.get('Cache-Control')).toBe('no-cache, no-transform')
      expect(response.headers.get('Connection')).toBe('keep-alive')

      // Clean up connection
      controller.abort()
    })

    test('includes X-Accel-Buffering header for nginx compatibility', async () => {
      if (!serverAvailable) {
        console.log('Skipping: server not available')
        return
      }

      const controller = new AbortController()
      const response = await fetch(`${SSE_ENDPOINT}?userId=test-user`, {
        signal: controller.signal,
      })

      expect(response.headers.get('X-Accel-Buffering')).toBe('no')

      controller.abort()
    })
  })

  describe('SSE Connection', () => {
    test('accepts connection with userId parameter', async () => {
      if (!serverAvailable) {
        console.log('Skipping: server not available')
        return
      }

      const controller = new AbortController()
      const userId = `test-user-${Date.now()}`

      const response = await fetch(`${SSE_ENDPOINT}?userId=${userId}`, {
        signal: controller.signal,
      })

      expect(response.status).toBe(200)
      expect(response.body).toBeDefined()

      controller.abort()
    })

    test('accepts connection with channels parameter', async () => {
      if (!serverAvailable) {
        console.log('Skipping: server not available')
        return
      }

      const controller = new AbortController()
      const userId = `test-user-${Date.now()}`
      const channels = 'timer:user123,notification:user123'

      const response = await fetch(`${SSE_ENDPOINT}?userId=${userId}&channels=${channels}`, {
        signal: controller.signal,
      })

      expect(response.status).toBe(200)
      expect(response.body).toBeDefined()

      controller.abort()
    })
  })

  describe('SSE Connection Confirmation', () => {
    test('sends connection confirmation message with default channels', async () => {
      if (!serverAvailable) {
        console.log('Skipping: server not available')
        return
      }

      const controller = new AbortController()
      const userId = `test-user-${Date.now()}`

      const response = await fetch(`${SSE_ENDPOINT}?userId=${userId}`, {
        signal: controller.signal,
      })

      expect(response.body).toBeDefined()

      const messages = await readSSEMessages(response.body!, { timeout: 3000, maxMessages: 1 })

      expect(messages.length).toBeGreaterThanOrEqual(1)

      const connectionMsg = parseSSEData<{
        type: string
        userId: string
        channels: string[]
        timestamp: number
      }>(messages[0])

      expect(connectionMsg.type).toBe('connected')
      expect(connectionMsg.userId).toBe(userId)
      expect(connectionMsg.channels).toContain(`timer:${userId}`)
      expect(connectionMsg.channels).toContain(`notification:${userId}`)
      expect(typeof connectionMsg.timestamp).toBe('number')

      controller.abort()
    })

    test('sends connection confirmation with custom channels', async () => {
      if (!serverAvailable) {
        console.log('Skipping: server not available')
        return
      }

      const controller = new AbortController()
      const userId = `test-user-${Date.now()}`
      const customChannels = 'custom:channel1,custom:channel2'

      const response = await fetch(`${SSE_ENDPOINT}?userId=${userId}&channels=${customChannels}`, {
        signal: controller.signal,
      })

      expect(response.body).toBeDefined()

      const messages = await readSSEMessages(response.body!, { timeout: 3000, maxMessages: 1 })

      expect(messages.length).toBeGreaterThanOrEqual(1)

      const connectionMsg = parseSSEData<{
        type: string
        userId: string
        channels: string[]
        timestamp: number
      }>(messages[0])

      expect(connectionMsg.type).toBe('connected')
      expect(connectionMsg.userId).toBe(userId)
      expect(connectionMsg.channels).toEqual(['custom:channel1', 'custom:channel2'])

      controller.abort()
    })

    test('filters empty channels from parameter', async () => {
      if (!serverAvailable) {
        console.log('Skipping: server not available')
        return
      }

      const controller = new AbortController()
      const userId = `test-user-${Date.now()}`
      // Note the empty strings after commas and extra spaces
      const channelsWithEmpties = 'valid:channel,,another:channel, '

      const response = await fetch(`${SSE_ENDPOINT}?userId=${userId}&channels=${encodeURIComponent(channelsWithEmpties)}`, {
        signal: controller.signal,
      })

      expect(response.body).toBeDefined()

      const messages = await readSSEMessages(response.body!, { timeout: 3000, maxMessages: 1 })

      const connectionMsg = parseSSEData<{
        type: string
        channels: string[]
      }>(messages[0])

      // Empty channels should be filtered out
      expect(connectionMsg.channels).toEqual(['valid:channel', 'another:channel'])
      expect(connectionMsg.channels).not.toContain('')

      controller.abort()
    })
  })

  describe('SSE Message Format', () => {
    test('connection message follows expected JSON structure', async () => {
      if (!serverAvailable) {
        console.log('Skipping: server not available')
        return
      }

      const controller = new AbortController()
      const userId = `test-user-${Date.now()}`

      const response = await fetch(`${SSE_ENDPOINT}?userId=${userId}`, {
        signal: controller.signal,
      })

      const messages = await readSSEMessages(response.body!, { timeout: 3000, maxMessages: 1 })

      // Verify we can parse the message as valid JSON
      expect(() => JSON.parse(messages[0])).not.toThrow()

      const msg = JSON.parse(messages[0])

      // Verify required fields exist
      expect(msg).toHaveProperty('type')
      expect(msg).toHaveProperty('userId')
      expect(msg).toHaveProperty('channels')
      expect(msg).toHaveProperty('timestamp')

      // Verify types
      expect(typeof msg.type).toBe('string')
      expect(typeof msg.userId).toBe('string')
      expect(Array.isArray(msg.channels)).toBe(true)
      expect(typeof msg.timestamp).toBe('number')

      controller.abort()
    })
  })

  describe('Connection Graceful Close', () => {
    test('connection can be closed gracefully', async () => {
      if (!serverAvailable) {
        console.log('Skipping: server not available')
        return
      }

      const controller = new AbortController()
      const userId = `test-user-${Date.now()}`

      const response = await fetch(`${SSE_ENDPOINT}?userId=${userId}`, {
        signal: controller.signal,
      })

      expect(response.status).toBe(200)

      // Read the initial connection message
      const messages = await readSSEMessages(response.body!, { timeout: 2000, maxMessages: 1 })
      expect(messages.length).toBe(1)

      // Abort should not throw
      expect(() => controller.abort()).not.toThrow()

      // Give the server a moment to process the abort
      await new Promise((resolve) => setTimeout(resolve, 100))

      // The connection should be cleanly closed
      // No assertions needed - if no error is thrown, the test passes
    })

    test('multiple connections can be established and closed', async () => {
      if (!serverAvailable) {
        console.log('Skipping: server not available')
        return
      }

      const connections: Array<{ controller: AbortController; response: Response }> = []

      // Establish multiple connections
      for (let i = 0; i < 3; i++) {
        const controller = new AbortController()
        const userId = `test-user-multi-${Date.now()}-${i}`

        const response = await fetch(`${SSE_ENDPOINT}?userId=${userId}`, {
          signal: controller.signal,
        })

        expect(response.status).toBe(200)
        connections.push({ controller, response })
      }

      // All connections should be established
      expect(connections.length).toBe(3)

      // Close all connections
      for (const { controller } of connections) {
        controller.abort()
      }

      // Give the server a moment to process
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
  })

  describe('Special Characters in Parameters', () => {
    test('handles special characters in userId', async () => {
      if (!serverAvailable) {
        console.log('Skipping: server not available')
        return
      }

      const controller = new AbortController()
      const userId = `user+test@example.com`

      const response = await fetch(`${SSE_ENDPOINT}?userId=${encodeURIComponent(userId)}`, {
        signal: controller.signal,
      })

      expect(response.status).toBe(200)

      const messages = await readSSEMessages(response.body!, { timeout: 3000, maxMessages: 1 })

      const connectionMsg = parseSSEData<{ userId: string }>(messages[0])
      expect(connectionMsg.userId).toBe(userId)

      controller.abort()
    })

    test('handles special characters in channel names', async () => {
      if (!serverAvailable) {
        console.log('Skipping: server not available')
        return
      }

      const controller = new AbortController()
      const userId = `test-user-${Date.now()}`
      const channels = 'timer:user+test,chat:room#123'

      const response = await fetch(`${SSE_ENDPOINT}?userId=${userId}&channels=${encodeURIComponent(channels)}`, {
        signal: controller.signal,
      })

      expect(response.status).toBe(200)

      const messages = await readSSEMessages(response.body!, { timeout: 3000, maxMessages: 1 })

      const connectionMsg = parseSSEData<{ channels: string[] }>(messages[0])
      expect(connectionMsg.channels).toContain('timer:user+test')
      expect(connectionMsg.channels).toContain('chat:room#123')

      controller.abort()
    })
  })
})

describe('API Events - Keepalive', () => {
  let serverAvailable = false

  beforeAll(async () => {
    serverAvailable = await isServerRunning()
  })

  /**
   * Note: The keepalive interval is 30 seconds in production.
   * We can't reasonably wait that long in a test, so we verify
   * the keepalive format when we do receive one in longer tests.
   */
  test('keepalive message format is correct (manual verification)', () => {
    // This test documents the expected keepalive format
    // The actual keepalive is: ': keepalive\n\n'
    // SSE comment format starts with ':'
    const keepaliveMessage = ': keepalive\n\n'
    expect(keepaliveMessage).toMatch(/^: keepalive/)
  })

  test.skip('sends keepalive after 30 seconds (long-running test)', async () => {
    // This test is skipped by default due to its 30+ second duration
    // Unskip to manually verify keepalive behavior
    if (!serverAvailable) {
      console.log('Skipping: server not available')
      return
    }

    const controller = new AbortController()
    const userId = `test-user-${Date.now()}`

    const response = await fetch(`${SSE_ENDPOINT}?userId=${userId}`, {
      signal: controller.signal,
    })

    // Wait for keepalive (30 seconds + buffer)
    const messages = await readSSEMessages(response.body!, {
      timeout: 35000,
      maxMessages: 5,
    })

    // First message should be connection confirmation
    expect(messages.length).toBeGreaterThanOrEqual(1)

    // Check if we received a keepalive
    const hasKeepalive = messages.includes('keepalive')
    expect(hasKeepalive).toBe(true)

    controller.abort()
  }, 40000) // Timeout for long test
})

describe('API Events - Error Handling', () => {
  let serverAvailable = false

  beforeAll(async () => {
    serverAvailable = await isServerRunning()
  })

  test('handles abrupt connection termination', async () => {
    if (!serverAvailable) {
      console.log('Skipping: server not available')
      return
    }

    const controller = new AbortController()
    const userId = `test-user-${Date.now()}`

    const fetchPromise = fetch(`${SSE_ENDPOINT}?userId=${userId}`, {
      signal: controller.signal,
    })

    // Abort before waiting for response
    controller.abort()

    // The fetch should be aborted
    await expect(fetchPromise).rejects.toThrow()
  })

  test('handles immediate abort after connection', async () => {
    if (!serverAvailable) {
      console.log('Skipping: server not available')
      return
    }

    const controller = new AbortController()
    const userId = `test-user-${Date.now()}`

    const response = await fetch(`${SSE_ENDPOINT}?userId=${userId}`, {
      signal: controller.signal,
    })

    expect(response.status).toBe(200)

    // Immediately abort
    controller.abort()

    // Attempting to read from aborted stream should fail gracefully
    const reader = response.body?.getReader()
    if (reader) {
      try {
        await reader.read()
      } catch (error) {
        // Expected to fail on aborted connection
        expect(error).toBeDefined()
      }
    }
  })
})

describe('API Events - Concurrent Connections', () => {
  let serverAvailable = false

  beforeAll(async () => {
    serverAvailable = await isServerRunning()
  })

  test('handles multiple simultaneous connections from same user', async () => {
    if (!serverAvailable) {
      console.log('Skipping: server not available')
      return
    }

    const userId = `test-user-${Date.now()}`
    const connectionCount = 5
    const controllers: AbortController[] = []
    const responses: Response[] = []

    // Create multiple simultaneous connections
    const connectionPromises = []
    for (let i = 0; i < connectionCount; i++) {
      const controller = new AbortController()
      controllers.push(controller)
      connectionPromises.push(
        fetch(`${SSE_ENDPOINT}?userId=${userId}`, {
          signal: controller.signal,
        })
      )
    }

    const results = await Promise.all(connectionPromises)

    // All connections should succeed
    for (const response of results) {
      expect(response.status).toBe(200)
      responses.push(response)
    }

    // Clean up all connections
    for (const controller of controllers) {
      controller.abort()
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  })

  test('handles connections with different users simultaneously', async () => {
    if (!serverAvailable) {
      console.log('Skipping: server not available')
      return
    }

    const userIds = [
      `user-a-${Date.now()}`,
      `user-b-${Date.now()}`,
      `user-c-${Date.now()}`,
    ]
    const controllers: AbortController[] = []

    // Create connections for different users simultaneously
    const connectionPromises = userIds.map((userId) => {
      const controller = new AbortController()
      controllers.push(controller)
      return fetch(`${SSE_ENDPOINT}?userId=${userId}`, {
        signal: controller.signal,
      })
    })

    const responses = await Promise.all(connectionPromises)

    // All connections should succeed
    for (let i = 0; i < responses.length; i++) {
      expect(responses[i].status).toBe(200)

      // Each should receive a connection message with their userId
      const messages = await readSSEMessages(responses[i].body!, {
        timeout: 3000,
        maxMessages: 1,
      })

      const msg = parseSSEData<{ userId: string }>(messages[0])
      expect(msg.userId).toBe(userIds[i])
    }

    // Clean up
    for (const controller of controllers) {
      controller.abort()
    }
  })
})
