# Database Architecture

> Drizzle ORM + **SQLite** via `better-sqlite3` (synchronous, server is source of truth)

History: PowerSync / Neon Postgres / Convex / offline-first client sync were
**all removed**. There is no client-side database, no IndexedDB, no async
driver. The server owns a single SQLite file; clients talk to it through
TanStack Start server functions.

## Find It Fast

| Looking for...      | Go to                                  |
| ------------------- | -------------------------------------- |
| Drizzle schema      | `src/drizzle/schema.ts`                |
| DB connection       | `src/drizzle/index.ts`                 |
| Drizzle config      | `drizzle.config.ts`                    |
| Migrations          | `src/drizzle/migrations/`              |
| Cross-tab sync       | `src/lib/sync/useBroadcastInvalidation.ts` |
| Server→client push  | `../systems/events.md`                 |

## Stack Overview

```
Browser (TanStack Query)        Server (TanStack Start)        Database
┌────────────────────┐         ┌────────────────────┐        ┌──────────────┐
│ useQuery / mutation │ ─fn──▶ │ createServerFn      │ ─SQL─▶ │ SQLite file  │
│ (no client DB)      │ ◀──── │ Drizzle (sync, no   │        │ WAL, 1 writer│
└────────────────────┘         │ await)              │        └──────────────┘
                                └────────────────────┘
```

## Connection (`src/drizzle/index.ts`)

```ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

const sqlite = new Database(resolve(process.env.SQLITE_PATH ?? ".data/dashboard.sqlite"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");   // wait, don't throw SQLITE_BUSY (SSE + many tabs)
sqlite.pragma("synchronous = NORMAL");  // safe with WAL, far fewer fsyncs

export const db = drizzle(sqlite, { schema });
export { sqlite };
export * from "./schema";               // tables + inferred types re-exported
```

Behaviour baked into this module (don't re-implement elsewhere):

- **Migrations auto-apply at import.** `migrate(db, …)` runs on module init from
  `MIGRATIONS_DIR` (default: the bundled `./migrations`). A failed migration
  **throws** — the app refuses to serve an unmigrated schema. You never call
  migrate manually at runtime.
- **Prod path safety.** In production `SQLITE_PATH` (and `MIGRATIONS_DIR`)
  **must be absolute** — a relative path resolves against the PM2 cwd and
  silently opens a different/empty DB. The module throws if it isn't.
- **Graceful shutdown.** `SIGTERM` (PM2 reload) drains ~3s then closes the
  handle; `SIGINT` (Ctrl-C) closes immediately.

## Schema (`src/drizzle/schema.ts`)

Dialect is **`drizzle-orm/sqlite-core`** — `sqliteTable`, `text`, `integer`,
`index`. There is **no `pgTable`, no `jsonb`, no `pg-core`**.

```ts
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const timers = sqliteTable("timers", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    timerType: text("timer_type").notNull().$type<"stopwatch" | "countdown" | "pomodoro">(),
    isRunning: integer("is_running").notNull().default(0),       // boolean = 0/1
    elapsedTime: integer("elapsed_time").notNull().default(0),   // ms
    laps: text("laps", { mode: "json" })                          // JSON ⇒ text + mode:"json"
        .$type<Array<{ number: number; lapTime: number }>>()
        .default([]),
    userId: text("user_id").notNull(),
    createdAt: text("created_at").notNull(),                      // ISO string, not Date
    updatedAt: text("updated_at").notNull(),
});

export type Timer = typeof timers.$inferSelect;
export type NewTimer = typeof timers.$inferInsert;
```

**Conventions (match the existing tables):**

- Booleans → `integer(...)` storing `0` / `1`.
- JSON → `text(col, { mode: "json" }).$type<T>()`. Drizzle does the
  serialize/parse — do **not** hand-roll `JSON.parse`/`stringify` for these
  columns (and never use bare `JSON` elsewhere — `SafeJSON` only).
- Timestamps → `text` ISO strings, not native date types.
- Column names: camelCase in TS, `snake_case` in the DB string.
- ~20 tables today: `timers`, `activityLogs`, `assistant*` (tasks, decisions,
  blockers, handoffs, streaks, badges, …), `notes`, `bookmarks`,
  `aiConversations`, `aiMessages`.

## CRUD — synchronous, no `await`

`better-sqlite3` is synchronous. Server functions are sync; **do not** `await`
db calls or mark handlers `async` for the DB's sake.

```ts
import { db, timers } from "@/drizzle";
import { desc, eq } from "drizzle-orm";

const rows = db.select().from(timers).where(eq(timers.userId, userId))
    .orderBy(desc(timers.createdAt)).all();

db.insert(timers).values({ id: crypto.randomUUID(), name: "T", timerType: "stopwatch",
    userId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).run();

db.insert(timers).values({ /* … */ })
    .onConflictDoUpdate({ target: timers.id, set: { name, updatedAt: new Date().toISOString() } }).run();

db.update(timers).set({ name: "New" }).where(eq(timers.id, id)).run();
db.delete(timers).where(eq(timers.id, id)).run();
```

Terminal verbs matter: `.all()` / `.get()` for reads, `.run()` for writes.

## Migration Workflow

```bash
bunx drizzle-kit generate   # diff schema.ts → new file in src/drizzle/migrations/
bunx drizzle-kit migrate    # apply (also auto-applied at server start)
bunx drizzle-kit studio     # browse the SQLite file
```

`drizzle-kit push` exists but prefer generate+migrate so the committed
migration matches what runs at boot.

## Gotchas

- **Single writer.** SQLite allows one writer at a time; `busy_timeout = 5000`
  makes concurrent writers wait rather than error. Keep write transactions short.
- **Relative path in prod = wrong DB.** Always set an absolute `SQLITE_PATH`
  in production (the module enforces this, but know why).
- **No `DATABASE_URL`.** SQLite path is the only DB config. Auth env
  (`@t3-oss/env-core`) is separate.
- **Server-only.** `@/drizzle` must never be imported into client bundles —
  it's reachable only through `createServerFn` handlers.

## Related Docs

- [Event System](./events.md) — server→client push + cross-tab invalidation
