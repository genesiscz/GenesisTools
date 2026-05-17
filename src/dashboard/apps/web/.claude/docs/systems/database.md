# Database Architecture

> Drizzle ORM + Neon PostgreSQL with offline-first sync via PowerSync

## Find It Fast

| Looking for...         | Go to                                |
| ---------------------- | ------------------------------------ |
| Drizzle schema         | `src/drizzle/schema.ts`              |
| DB connection          | `src/drizzle/index.ts`               |
| PowerSync schema       | `src/lib/db/powersync.ts`            |
| PowerSync connector    | `src/lib/db/powersync-connector.ts`  |
| Drizzle config         | `drizzle.config.ts`                  |
| Environment vars       | `src/lib/env.ts`                     |
| Migrations             | `src/drizzle/migrations/`            |

## Stack Overview

```
Frontend (Browser)          Server (TanStack Start)        Database
┌─────────────────┐         ┌──────────────────┐          ┌─────────┐
│ PowerSync       │ ──sync──▶│ Drizzle ORM     │ ──SQL───▶│ Neon    │
│ (IndexedDB)     │◀──SSE───│ Server Functions │          │ Postgres│
└─────────────────┘         └──────────────────┘          └─────────┘
```

## Key Files

### Drizzle Schema (`src/drizzle/schema.ts`)

Defines tables with type inference:

```ts
import { pgTable, text, integer, jsonb } from 'drizzle-orm/pg-core'

export const timers = pgTable('timers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  timerType: text('timer_type').notNull().$type<'stopwatch' | 'countdown'>(),
  isRunning: integer('is_running').notNull().default(0),
  // ...
})

// Auto-inferred types
export type Timer = typeof timers.$inferSelect
export type NewTimer = typeof timers.$inferInsert
```

### DB Connection (`src/drizzle/index.ts`)

```ts
import { drizzle } from 'drizzle-orm/neon-http'
import { neon } from '@neondatabase/serverless'
import { env } from '@/lib/env'
import * as schema from './schema'

const sql = neon(env.DATABASE_URL)
export const db = drizzle(sql, { schema })

// Re-export for convenience
export * from './schema'
```

### Environment Variables (`src/lib/env.ts`)

```ts
import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().min(1),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  },
  runtimeEnv: process.env,
})
```

## CRUD Operations

### Select (Read)

```ts
import { db, timers } from '@/drizzle'
import { eq, desc } from 'drizzle-orm'

// Get all timers for user
const results = await db.select()
  .from(timers)
  .where(eq(timers.userId, userId))
  .orderBy(desc(timers.createdAt))
```

### Insert (Create)

```ts
await db.insert(timers).values({
  id: crypto.randomUUID(),
  name: 'My Timer',
  timerType: 'stopwatch',
  userId: 'user123',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
})
```

### Upsert (Insert or Update)

```ts
await db.insert(timers)
  .values({ id, name, ... })
  .onConflictDoUpdate({
    target: timers.id,
    set: { name, updatedAt: new Date().toISOString() }
  })
```

### Update

```ts
await db.update(timers)
  .set({ name: 'New Name', updatedAt: new Date().toISOString() })
  .where(eq(timers.id, timerId))
```

### Delete

```ts
await db.delete(timers)
  .where(eq(timers.id, timerId))
```

## Migration Workflow

### Generate Migration

```bash
bunx drizzle-kit generate
```

### Push Schema (Development)

```bash
bunx drizzle-kit push
```

### View Database (Drizzle Studio)

```bash
bunx drizzle-kit studio
```

## Gotchas

- **Boolean columns**: Use `integer` (0/1) for SQLite compatibility with PowerSync
- **JSON columns**: Use `jsonb` in Drizzle, but `text` in PowerSync (JSON stringified)
- **Timestamps**: Store as ISO strings (`text`), not native timestamps
- **Column names**: Drizzle uses camelCase in code, snake_case in DB. PowerSync uses snake_case directly.

## Related Docs

- [Type Sharing](../patterns/type-sharing.md) - Keep Drizzle and PowerSync in sync
- [Event System](./events.md) - Real-time updates after DB changes
