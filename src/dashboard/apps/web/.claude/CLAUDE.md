# Dashboard Web App

> TanStack Start + Drizzle ORM + SQLite (better-sqlite3)

## Quick Start

```bash
# Install dependencies
bun install

# Start dev server
bun dev

# Database operations
bunx drizzle-kit generate  # Generate migrations
bunx drizzle-kit migrate   # Apply migrations
bunx drizzle-kit studio    # Open Drizzle Studio
```

## Architecture Summary

| Layer      | Technology                              | Location                                    |
| ---------- | --------------------------------------- | ------------------------------------------- |
| Frontend   | TanStack Start (React 19)               | `src/routes/`                               |
| State      | TanStack Query + Drizzle                | `src/lib/*/hooks/`                          |
| Server     | Drizzle ORM (better-sqlite3)            | `src/drizzle/`                              |
| Database   | SQLite (file: `.data/dashboard.sqlite`) | local / persistent volume                   |
| Cross-tab  | BroadcastChannel (same device)          | `src/lib/sync/`                             |
| Realtime   | SSE domain event bus (cross-device)     | `src/lib/events/`                           |

> Note: PowerSync / Neon Postgres / Convex / **client-side DB** removed.
> SSE was **not** removed — it was generalized into a per-user domain event
> bus (`src/lib/events/event-bus.server.ts`, `/api/events`). See `docs/systems/events.md`.

## Key Patterns

- **Server is the source of truth**. SQLite file on disk. No offline-first / no IndexedDB sync.
- **Multi-tab sync**: every mutation calls `broadcastInvalidate(channel, queryKey)` after success. Other tabs listen via `useBroadcastInvalidation` and re-fetch via TanStack Query.
- **Server functions** use `createServerFn` + Drizzle (sync — better-sqlite3 has no `await`).

---

## Context Triggers

<context_trigger keywords="db,database,schema,drizzle,sqlite,migration">
**Load:** src/drizzle/schema.ts, src/drizzle/index.ts
**Files:** src/drizzle/schema.ts, drizzle.config.ts
**Quick:** Drizzle ORM + better-sqlite3. Define schema in `src/drizzle/schema.ts` using `sqliteTable`. JSON fields are `text` columns + SafeJSON parse/stringify in server functions. Migrations: `bunx drizzle-kit generate` then `bunx drizzle-kit migrate`.
</context_trigger>

<context_trigger keywords="sync,broadcast,cross-tab,realtime,sse,events">
**Load:** src/lib/sync/useBroadcastInvalidation.ts, src/lib/events/useServerEvents.ts
**Files:** src/lib/sync/useBroadcastInvalidation.ts, src/lib/events/event-bus.server.ts, src/lib/events/useServerEvents.ts
**Quick:** Two layers. Same-device tabs: `useInvalidateAndBroadcast(channel)` in mutations + `useBroadcastInvalidation(channel)` in feature root. Cross-device/process: `emitDomainEvent(userId, domain, e)` after a server write + `useServerEvents({userId, domain, onEvent})` client-side. Both just trigger TanStack Query refetch. Full detail: docs/systems/events.md.
</context_trigger>

<context_trigger keywords="env,environment,config">
**Load:** src/lib/env.ts
**Files:** src/lib/env.ts
**Quick:** SQLite path is hardcoded — no DATABASE_URL needed. Auth env via @t3-oss/env-core.
</context_trigger>

<context_trigger keywords="timer,stopwatch,countdown,pomodoro,activity-log,focus">
**Load:** src/lib/timer/
**Files:** src/lib/timer/timer-sync.server.ts, src/lib/timer/components/, src/lib/timer/hooks/useTimerEngine.ts
**Quick:** Timer engine in `useTimerEngine.ts` (requestAnimationFrame display loop). Server I/O in `timer-sync.server.ts`. Pomodoro fields live on the timer record. Phase auto-advance lives in the engine (see Focus Mode plan).
</context_trigger>

<context_trigger keywords="mcp,model-context-protocol,ai-tool">
**Load:** src/lib/mcp/server.ts
**Files:** src/lib/mcp/server.ts, src/lib/mcp/tools/, src/routes/mcp.ts
**Quick:** MCP server exposes tasks + timers to AI assistants. Add new tools by creating a file under `src/lib/mcp/tools/` and calling `register*Tools(server)` from `server.ts`.
</context_trigger>

---

## Common Tasks

### Add a New Database Table

1. Define in `src/drizzle/schema.ts` using `sqliteTable`. JSON columns are `text` — use `.$type<MyType>()` for typing.
2. Run `bunx drizzle-kit generate && bunx drizzle-kit migrate`
3. In any server function, import `db` from `@/drizzle` — calls are sync, no `await`.

### Broadcast Across Tabs After Mutation

```ts
import { useInvalidateAndBroadcast, ASSISTANT_SYNC_CHANNEL } from "@/lib/sync/useBroadcastInvalidation";
// invalidates locally AND notifies sibling tabs in one call:
const invalidate = useInvalidateAndBroadcast(ASSISTANT_SYNC_CHANNEL);
const mutation = useMutation({
    mutationFn: createTask,
    onSuccess: () => invalidate(["tasks"]),
});
```

### Create a Server Function

```ts
import { createServerFn } from "@tanstack/react-start";
import { db, myTable } from "@/drizzle";

export const myServerFn = createServerFn({ method: "POST" })
  .inputValidator((d: MyInput) => d)
  .handler(({ data }) => {                  // sync
    db.insert(myTable).values(data).run();
    return { success: true };
  });
```

---

## Environment Setup

No `DATABASE_URL` needed — SQLite lives at `.data/dashboard.sqlite`. WorkOS env vars (auth) stay required in `.env.local`.

## React Guidelines

- **No `useCallback`/`useMemo`** - React Compiler handles memoization
- Use plain functions, compiler optimizes automatically
