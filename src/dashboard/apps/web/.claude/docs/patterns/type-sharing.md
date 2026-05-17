# Type Sharing (Drizzle + PowerSync)

> Keep server (Drizzle) and client (PowerSync) schemas in sync

## Find It Fast

| Looking for...         | Go to                           |
| ---------------------- | ------------------------------- |
| Drizzle schema (source)| `src/drizzle/schema.ts`         |
| PowerSync schema       | `src/lib/db/powersync.ts`       |
| Sync adapter           | `src/lib/db/powersync-connector.ts` |
| Example sync server fn | `src/lib/timer/timer-sync.server.ts` |

## The Problem

Drizzle runs on the server, PowerSync runs in the browser. Both need identical schemas or sync breaks.

```
Drizzle Schema (Server)              PowerSync Schema (Client)
┌──────────────────────┐             ┌──────────────────────┐
│ timers.isRunning     │  ─ must ─▶  │ timers.is_running    │
│ (integer, default 0) │    match    │ (integer)            │
└──────────────────────┘             └──────────────────────┘
```

## Schema Alignment Rules

### 1. Column Names: CamelCase vs snake_case

| Drizzle Code          | DB Column       | PowerSync Column |
| --------------------- | --------------- | ---------------- |
| `isRunning`           | `is_running`    | `is_running`     |
| `timerType`           | `timer_type`    | `timer_type`     |
| `userId`              | `user_id`       | `user_id`        |

**Rule**: Drizzle uses camelCase in TypeScript, but maps to snake_case in DB. PowerSync uses snake_case directly.

### 2. Column Types Must Match

| Data Type     | Drizzle            | PowerSync          | Note                          |
| ------------- | ------------------ | ------------------ | ----------------------------- |
| String        | `text()`           | `column.text`      | Direct match                  |
| Integer       | `integer()`        | `column.integer`   | Direct match                  |
| Boolean       | `integer()`        | `column.integer`   | Use 0/1, not true/false       |
| JSON          | `jsonb()`          | `column.text`      | PowerSync stores as string    |
| Timestamp     | `text()`           | `column.text`      | Use ISO strings, not Date     |

### 3. JSON Handling Gotcha

**Drizzle** stores JSON natively:
```ts
laps: jsonb('laps').$type<Array<{ id: string; time: number }>>()
```

**PowerSync** stores JSON as text string:
```ts
laps: column.text  // Needs JSON.parse() on read
```

**Sync adapter must convert**:
```ts
// When sending to PowerSync
laps: JSON.stringify(timer.laps)

// When reading from PowerSync
laps: JSON.parse(row.laps || '[]')
```

## Adding a New Table

### Step 1: Define in Drizzle (`src/drizzle/schema.ts`)

```ts
export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  isActive: integer('is_active').notNull().default(1),
  metadata: jsonb('metadata').$type<{ color?: string }>().default({}),
  userId: text('user_id').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  userIdIdx: index('idx_projects_user_id').on(table.userId),
}))

// Export inferred types
export type Project = typeof projects.$inferSelect
export type NewProject = typeof projects.$inferInsert
```

### Step 2: Mirror in PowerSync (`src/lib/db/powersync.ts`)

Add to `schemaConfig`:
```ts
const schemaConfig = {
  // ... existing tables
  projects: {
    name: "text" as const,
    is_active: "integer" as const,
    metadata: "text" as const,  // JSON stored as text
    user_id: "text" as const,
    created_at: "text" as const,
    updated_at: "text" as const,
  },
}
```

Add to Schema initialization:
```ts
APP_SCHEMA = new Schema({
  // ... existing tables
  projects: new Table({
    name: column.text,
    is_active: column.integer,
    metadata: column.text,
    user_id: column.text,
    created_at: column.text,
    updated_at: column.text,
  }),
})
```

### Step 3: Run Migration

```bash
bunx drizzle-kit generate
bunx drizzle-kit push
```

### Step 4: Update Sync Adapter

In `src/lib/db/powersync-connector.ts`, handle new table in `uploadData()`:
```ts
if (op.table === 'projects') {
  await processProjectOperation(op)
}
```

## Type Usage Patterns

### Server Functions (Type-Safe)

```ts
import { db, projects, type Project, type NewProject } from '@/drizzle'

// Insert with type checking
const newProject: NewProject = {
  id: crypto.randomUUID(),
  name: 'My Project',
  userId: 'user123',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}
await db.insert(projects).values(newProject)

// Query returns typed results
const results: Project[] = await db.select()
  .from(projects)
  .where(eq(projects.userId, userId))
```

### Client (PowerSync + Type Coercion)

```ts
// PowerSync returns unknown types, cast to Drizzle types
import type { Timer } from '@/drizzle'

const row = await db.get('SELECT * FROM timers WHERE id = ?', [id])
const timer: Timer = {
  ...row,
  laps: JSON.parse(row.laps || '[]'),
  pomodoroSettings: row.pomodoro_settings
    ? JSON.parse(row.pomodoro_settings)
    : null,
}
```

## Sync Data Flow

```
PowerSync (Client)                Sync Endpoint                 Drizzle (Server)
┌──────────────────┐             ┌──────────────────┐          ┌──────────────────┐
│ CrudEntry {      │             │ Convert:         │          │ Insert/Update    │
│   table: 'timers'│  ─ POST ──▶ │  snake_case      │ ───────▶ │ with Drizzle     │
│   data: {...}    │             │  JSON.parse()    │          │ types            │
│ }                │             └──────────────────┘          └──────────────────┘
```

**Sync handler converts PowerSync format to Drizzle**:
```ts
// src/lib/timer/timer-sync.server.ts
await db.insert(timers).values({
  id: data.id as string,
  name: data.name as string,
  timerType: data.timer_type as 'stopwatch' | 'countdown',
  isRunning: (data.is_running as number) ?? 0,
  laps: data.laps as Array<{ id: string; time: number; delta: number }>,
  // ...
})
```

## Checklist: Adding a New Synced Table

- [ ] Define table in `src/drizzle/schema.ts`
- [ ] Export `$inferSelect` and `$inferInsert` types
- [ ] Add matching schema to `src/lib/db/powersync.ts` (schemaConfig + Schema init)
- [ ] Run `bunx drizzle-kit generate && bunx drizzle-kit push`
- [ ] Update `uploadData()` in `powersync-connector.ts`
- [ ] Add sync handler in appropriate `.server.ts` file
- [ ] Test round-trip: client write -> server -> broadcast -> client refetch

## Related Docs

- [Database](../systems/database.md) - Drizzle ORM setup
- [Event System](../systems/events.md) - Broadcast after sync
