# Event System (Real-Time Sync)

> Generic SSE-based event broadcasting for server-to-client push notifications

## Find It Fast

| Looking for...         | Go to                           |
| ---------------------- | ------------------------------- |
| Server broadcaster     | `src/lib/events/server.ts`      |
| Client subscriber      | `src/lib/events/client.ts`      |
| SSE endpoint           | `src/routes/api.events.ts`      |
| Usage example          | `src/lib/timer/timer-sync.server.ts` |

## Architecture

```
Server Event                    SSE Connection               Client Handler
┌────────────────┐             ┌──────────────┐             ┌──────────────┐
│ broadcastToUser│ ───emit────▶│ /api/events  │ ───SSE────▶│ EventClient  │
│ ('timer', id)  │             │ (per-user)   │             │ .subscribe() │
└────────────────┘             └──────────────┘             └──────────────┘
```

## Server-Side Broadcasting

### Import

```ts
import { broadcast, broadcastToUser, broadcastToScope } from '@/lib/events/server'
```

### Channel Patterns

| Pattern            | Function           | Example                              |
| ------------------ | ------------------ | ------------------------------------ |
| `{feature}:{userId}` | `broadcastToUser()` | `timer:user123`                     |
| `{feature}:{scope}:{id}` | `broadcastToScope()` | `chat:room:room456`             |
| `{feature}:*`      | `broadcastToFeature()` | `notification:*`                 |
| Custom             | `broadcast()`      | Any channel name                     |

### Usage

```ts
// After database mutation, notify the user
import { broadcastToUser } from '@/lib/events/server'

await db.update(timers).set({ ... }).where(eq(timers.id, id))

// Push update to client
broadcastToUser('timer', userId, {
  type: 'sync',
  timestamp: Date.now()
})
```

### Scoped Broadcasting

```ts
// Chat room message
broadcastToScope('chat', 'room', 'room456', {
  type: 'message',
  content: 'Hello!',
  userId: 'user123'
})
// -> Broadcasts to channel: chat:room:room456
```

## Client-Side Subscription

### Import

```ts
import { getEventClient } from '@/lib/events/client'
```

### Connect and Subscribe

```ts
const client = getEventClient()

// Connect with specific channels
client.connect('user123', ['timer:user123', 'notification:user123'])

// Subscribe to events
const unsubscribe = client.subscribe('timer:user123', (data) => {
  console.log('Timer event:', data)
  // Trigger refetch, update state, etc.
})

// Cleanup on unmount
return () => unsubscribe()
```

### React Hook Pattern

```tsx
function useTimerSync(userId: string) {
  const queryClient = useQueryClient()

  useEffect(() => {
    const client = getEventClient()
    client.connect(userId, [`timer:${userId}`])

    const unsubscribe = client.subscribe(`timer:${userId}`, () => {
      // Invalidate queries to refetch fresh data
      queryClient.invalidateQueries({ queryKey: ['timers'] })
    })

    return () => {
      unsubscribe()
      client.disconnect()
    }
  }, [userId, queryClient])
}
```

## SSE Endpoint (`/api/events`)

### Query Parameters

| Param      | Required | Description                              |
| ---------- | -------- | ---------------------------------------- |
| `userId`   | Yes      | User ID for authentication               |
| `channels` | No       | Comma-separated list of channels         |

### Request

```
GET /api/events?userId=user123&channels=timer:user123,notification:user123
```

### Response Format

```json
// Connection confirmation
{ "type": "connected", "userId": "user123", "channels": [...], "timestamp": 1234567890 }

// Event message
{ "channel": "timer:user123", "data": { "type": "sync" }, "timestamp": 1234567890 }
```

## Full Integration Example

### Server Function (after DB write)

```ts
// src/lib/timer/timer-sync.server.ts
export const deleteTimerFromServer = createServerFn({ method: 'POST' })
  .inputValidator((d: { timerId: string; userId: string }) => d)
  .handler(async ({ data }) => {
    // 1. Delete from database
    await db.delete(timers).where(eq(timers.id, data.timerId))

    // 2. Broadcast event to user's clients
    broadcastToUser('timer', data.userId, {
      type: 'sync',
      timestamp: Date.now()
    })

    return { success: true }
  })
```

### Client Component

```tsx
function TimerList({ userId }: { userId: string }) {
  const queryClient = useQueryClient()

  // Subscribe to sync events
  useEffect(() => {
    const client = getEventClient()
    client.connect(userId, [`timer:${userId}`])

    const unsubscribe = client.subscribe(`timer:${userId}`, () => {
      // Refetch when server says data changed
      queryClient.invalidateQueries({ queryKey: ['timers'] })
    })

    return () => unsubscribe()
  }, [userId])

  // ... render timers
}
```

## Gotchas

- **One connection per app**: `getEventClient()` returns a singleton
- **Auto-reconnect**: Browser's EventSource handles reconnection automatically
- **Keepalive**: Server sends keepalive every 30s to prevent timeout
- **Channel matching**: Client only receives events for subscribed channels

## Related Docs

- [Database](./database.md) - Drizzle ORM for DB operations
- [Type Sharing](../patterns/type-sharing.md) - Consistent types across stack
