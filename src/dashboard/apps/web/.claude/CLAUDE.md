# Dashboard Web App

> TanStack Start + Drizzle ORM + Neon + PowerSync

## Quick Start

```bash
# Install dependencies
bun install

# Start dev server
bun dev

# Database operations
bunx drizzle-kit push      # Push schema changes
bunx drizzle-kit generate  # Generate migrations
bunx drizzle-kit studio    # Open Drizzle Studio
```

## Architecture Summary

| Layer      | Technology       | Location                     |
| ---------- | ---------------- | ---------------------------- |
| Frontend   | TanStack Start   | `src/routes/`                |
| State      | PowerSync        | `src/lib/db/powersync.ts`    |
| Server     | Drizzle ORM      | `src/drizzle/`               |
| Database   | Neon PostgreSQL  | Cloud                        |
| Real-time  | SSE Events       | `src/lib/events/`            |

## Key Patterns

- **Offline-first**: PowerSync (browser) -> Sync -> Drizzle (server) -> Neon
- **Type-safe**: Drizzle infers types, share with PowerSync
- **Real-time**: SSE broadcasts after DB mutations

---

## Context Triggers

<context_trigger keywords="drizzle,database,schema,table,migration,neon,postgres">
**Load:** .claude/docs/systems/database.md
**Files:** src/drizzle/schema.ts, src/drizzle/index.ts, drizzle.config.ts
**Quick:** Drizzle ORM + Neon. Define schema in `src/drizzle/schema.ts`, run `bunx drizzle-kit push`.
</context_trigger>

<context_trigger keywords="sse,events,broadcast,realtime,sync,push,notify">
**Load:** .claude/docs/systems/events.md
**Files:** src/lib/events/server.ts, src/lib/events/client.ts, src/routes/api.events.ts
**Quick:** Use `broadcastToUser()` after DB writes. Client subscribes via `getEventClient()`.
</context_trigger>

<context_trigger keywords="powersync,offline,indexeddb,sync,types,schema-alignment">
**Load:** .claude/docs/patterns/type-sharing.md
**Files:** src/drizzle/schema.ts, src/lib/db/powersync.ts, src/lib/db/powersync-connector.ts
**Quick:** Drizzle uses camelCase, PowerSync uses snake_case. JSON stored as text in PowerSync.
</context_trigger>

<context_trigger keywords="env,environment,config,DATABASE_URL,secrets">
**Load:** .claude/docs/systems/database.md
**Files:** src/lib/env.ts, .env.local
**Quick:** Type-safe env via @t3-oss/env-core. Add vars to `src/lib/env.ts`.
</context_trigger>

<context_trigger keywords="timer,stopwatch,countdown,pomodoro,activity-log">
**Load:** .claude/docs/systems/events.md
**Files:** src/lib/timer/timer-sync.server.ts, src/lib/timer/components/
**Quick:** Timer feature uses full stack: Drizzle for DB, PowerSync for offline, SSE for sync.
</context_trigger>

---

## Common Tasks

### Add a New Database Table

1. Define in `src/drizzle/schema.ts`
2. Mirror in `src/lib/db/powersync.ts`
3. Run `bunx drizzle-kit generate && bunx drizzle-kit push`
4. Update sync handler in connector

See: [Type Sharing](docs/patterns/type-sharing.md)

### Broadcast Events After DB Changes

```ts
import { broadcastToUser } from '@/lib/events/server'

// After mutation
broadcastToUser('feature', userId, { type: 'sync' })
```

See: [Event System](docs/systems/events.md)

### Create Server Function

```ts
import { createServerFn } from '@tanstack/react-start'
import { db, myTable } from '@/drizzle'

export const myServerFn = createServerFn({ method: 'POST' })
  .inputValidator((d: MyInput) => d)
  .handler(async ({ data }) => {
    // Use Drizzle for DB ops
    await db.insert(myTable).values(data)
    return { success: true }
  })
```

---

## Environment Setup

Required in `.env.local`:

```
DATABASE_URL=postgresql://...@neon.tech/neondb
```

## React Guidelines

- **No `useCallback`/`useMemo`** - React Compiler handles memoization
- Use plain functions, compiler optimizes automatically
