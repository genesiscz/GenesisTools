# Prod Audit — Data Layer & Persistence Robustness

Scope: `src/dashboard/` (Turborepo; `apps/web` = TanStack Start, `apps/server` = Nitro/h3).
DB: `drizzle-orm/better-sqlite3`, single local SQLite file. Target: self-hosted Node under PM2, trusted group, no data loss across restarts/deploys.

Audited at commit on branch `feat/say-macos-fallback`. Read-only audit.

---

## P0 Blockers

### P0-1 — SQLite path is `cwd`-relative; PM2 / wrong cwd silently opens a *different* DB (data loss)
- **Where:** `apps/web/src/drizzle/index.ts:5,7`
  ```ts
  const DB_PATH = process.env.SQLITE_PATH ?? ".data/dashboard.sqlite";
  const sqlite = new Database(DB_PATH);
  ```
- **Problem:** `.data/dashboard.sqlite` is a **relative** path resolved against `process.cwd()`. `better-sqlite3` *creates* the file if it does not exist. Under PM2 the cwd is whatever `cwd:` is set to in the ecosystem file (default = where `pm2 start` was invoked), which is almost never `apps/web/`. On the first deploy/restart with a different cwd the app silently opens/creates a **brand-new empty** `.data/dashboard.sqlite` elsewhere on disk. To the user this is indistinguishable from total data loss — old data is intact but orphaned at the old relative location. `drizzle.config.ts:8` has the identical default, so `drizzle-kit migrate` may also target a different file than the running app.
- **Fix:** Resolve to an **absolute, deploy-stable** path. Require `SQLITE_PATH` to be an absolute path in production and fail fast at boot if it is not (`path.isAbsolute`). E.g. `SQLITE_PATH=/var/lib/dashboard/dashboard.sqlite`. Add a startup assertion in `drizzle/index.ts` that logs the resolved absolute path (`path.resolve(DB_PATH)`) so a future operator can triage from logs. Point the PM2 ecosystem file and `drizzle.config.ts` at the same absolute path via the same env var.

### P0-2 — No backup / restore story at all
- **Where:** entire repo — no Litestream, no `VACUUM INTO`, no rsync/cron hook, no documented restore runbook (`rg pm2|litestream|VACUUM|backup` → nothing).
- **Problem:** Production requirement is explicitly "data must NOT be lost across restarts/deploys." A single SQLite file with zero backup means one bad deploy, one `rm -rf` of the wrong dir, one disk fault, or one corrupt WAL checkpoint = unrecoverable loss. For a trusted-group prod this is P0-adjacent and, given the explicit no-loss requirement, treated here as P0.
- **Fix:** Pick one and wire it before go-live:
  - **Litestream** (recommended) — continuous streaming replication of the SQLite file to S3/B2/local disk; gives point-in-time restore. Runs as a sidecar process / PM2 app.
  - Or a cron job: `sqlite3 $SQLITE_PATH ".backup '/backups/dashboard-$(date +%F-%H%M).sqlite'"` (or `VACUUM INTO`) with rotation + offsite copy. `.backup`/`VACUUM INTO` are WAL-safe (consistent snapshot) — do **not** just `cp` the `.sqlite` while the app is running (WAL not folded in).
  - Document a one-command restore procedure in the deploy docs.

### P0-3 — No runtime migration runner; schema drift on deploy = insert crashes / silent corruption
- **Where:** No `migrate()` call anywhere in app code (`rg "migrate\(|migrator|better-sqlite3/migrator"` → only `drizzle-kit` CLI references). `apps/web/src/drizzle/index.ts` opens the DB and never applies migrations. Migrations exist as files only: `apps/web/src/drizzle/migrations/0000…0005_*.sql` (+ `meta/`). Application is purely the manual CLI step `bunx drizzle-kit migrate` (documented in `apps/web/.claude/CLAUDE.md`).
- **Problem:** On a self-hosted PM2 deploy with no migration runbook, a schema change shipped without the operator manually running `drizzle-kit migrate` means the app boots against a stale schema. New inserts referencing new `notNull` columns throw at runtime, or (worse) writes land against an old shape — data-integrity / corruption risk. `drizzle-kit migrate` also needs `drizzle-kit` (a devDependency) present on the prod host and the correct `SQLITE_PATH` (see P0-1) — easy to get wrong.
- **Fix:** Apply migrations programmatically at server boot before serving traffic:
  ```ts
  import { migrate } from "drizzle-orm/better-sqlite3/migrator";
  migrate(db, { migrationsFolder: "<abs path>/src/drizzle/migrations" });
  ```
  Resolve the migrations folder to an absolute path (same cwd hazard as P0-1). Alternatively make `pnpm/bun db:migrate` a hard, non-skippable deploy step with the absolute `SQLITE_PATH` exported, and document the rollback story (drizzle does not auto-generate down migrations — note this).

---

## P1 — High

### P1-1 — Multi-statement timer mutation is not wrapped in a transaction
- **Where:** `apps/web/src/lib/timer/timer-sync.server.ts:58-131` (`mutate()`).
- **Problem:** `mutate()` does SELECT → UPDATE (`WHERE id=? AND version=?`) → second SELECT → separate `db.insert(activityLogs)`. The optimistic-concurrency check is sound for the timer row itself (the `WHERE version=?` UPDATE is atomic; `result.changes === 0` → `TimerConflict`, so lost updates are prevented). But the activity-log insert is a **separate statement after** the timer UPDATE, inside a `try/catch` that only `console.error`s. A crash/process kill between the UPDATE and the insert leaves the timer advanced with no corresponding activity-log row → drift in productivity stats / focus aggregation (which derive entirely from `activity_logs`).
- **Fix:** Wrap the read-transform-write-plus-log sequence in `db.transaction(() => { … })` (better-sqlite3 transactions are synchronous and nest-safe). Keep the version check inside the transaction.

### P1-2 — No `busy_timeout` pragma → user-visible `SQLITE_BUSY` under contention
- **Where:** `apps/web/src/drizzle/index.ts:10-11` sets `journal_mode=WAL` and `foreign_keys=ON` but **no** `busy_timeout`.
- **Problem:** better-sqlite3 is synchronous; with SSE + WebSocket + multiple browser tabs all triggering server-fn writes, concurrent write attempts (or a writer vs. a long checkpoint) will immediately throw `SQLITE_BUSY` instead of waiting. WAL allows concurrent readers but still serializes writers — without a busy timeout the loser errors out and the mutation is lost from the user's perspective.
- **Fix:** Add `sqlite.pragma("busy_timeout = 5000");` (5s) right after the WAL pragma. Consider `synchronous = NORMAL` (safe with WAL, faster) — explicitly a tradeoff decision, document it.

### P1-3 — PM2 cluster mode would corrupt / fragment state — fork mode must be mandated
- **Where:** deployment (no ecosystem file exists yet); `apps/server/server/routes/_ws.ts:10` keeps an in-memory `clients` Map; `apps/web/src/lib/timer/timer-events.server.ts` (SSE event bus) is similarly in-process.
- **Problem:** PM2 `cluster` mode forks N Node workers. Each worker opens its **own** better-sqlite3 handle to the one file — WAL tolerates this but greatly increases `SQLITE_BUSY` and checkpoint contention, and any non-transactional sequence (P1-1) races across processes. Worse, the WS `clients` Map and SSE bus are per-process, so cross-tab/realtime broadcast silently breaks across workers (a client on worker A never receives events emitted on worker B).
- **Fix:** Mandate single-instance **fork** mode in the PM2 ecosystem file: `exec_mode: "fork"`, `instances: 1`. Document that horizontal scaling is **not supported** with the current SQLite + in-memory-bus architecture.

### P1-4 — `userId` is taken from client input, not the authenticated session (cross-user data risk)
- **Where:** e.g. `apps/web/src/lib/assistant/assistant.server.ts:68-118` (`getAssistantTasks`/`createAssistantTask` trust `data.userId` / `data: NewAssistantTask`), `apps/web/src/lib/timer/timer-sync.server.ts:141` (`getTimersFromServer` takes raw `userId`), `bookmarks.server.ts:46-51`, `notes.server.ts`.
- **Problem:** Every `createServerFn` handler reads/writes scoped by a client-supplied `userId` with no check that it matches the authenticated WorkOS session. A trusted-group prod still means any member can read or overwrite another member's tasks/timers/notes by passing a different `userId`. This is auth-shaped but materially a data-integrity risk. (Auth ownership may be another auditor's primary scope — flagged here for the data angle.)
- **Fix:** Derive `userId` server-side from the authenticated session in each handler; never accept it from the client payload.

---

## P2 — Medium

### P2-1 — Dead `server-db.ts` carries a stale, divergent schema
- **Where:** `apps/web/src/lib/server-db.ts` (entire file). No importers (`rg "server-db"` → none).
- **Problem:** Defines its own raw `CREATE TABLE IF NOT EXISTS timers/activity_logs` via `db.exec(...)` against `process.cwd()/.data/dashboard.sqlite`, **missing** the `version` column and **all** assistant/notes/bookmarks/AI tables. It also opens a *second* better-sqlite3 handle to the same file. Harmless only because nothing imports it and `IF NOT EXISTS` won't clobber existing tables — but it's a latent landmine: any future import would create a second connection and could be mistaken for the source of truth, and its schema is already wrong.
- **Fix:** Delete the file (`git rm apps/web/src/lib/server-db.ts`).

### P2-2 — `/api/sync/upload` is a TODO stub that lies `success: true`
- **Where:** `apps/server/server/routes/api/sync/upload.ts:33-38`.
- **Problem:** Accepts a `{ crud: CrudOperation[] }` batch and returns `success: true` for every op while the body explicitly has `// TODO: Apply operations to database` — it never writes anything. Not a data-loss footgun (nothing is written, nothing is destroyed) but it is a **silent-data-loss API surface**: any client that believes this endpoint persisted its writes will lose them. Legacy of the ripped-out PowerSync/offline-sync layer.
- **Fix:** Delete the route (PowerSync/offline-first was intentionally removed; server is the source of truth). If kept, return `501 Not Implemented`.

### P2-3 — `/api/timers` (Nitro) is an in-memory `Map` stub
- **Where:** `apps/server/server/routes/api/timers/index.ts:5` (`const timers = new Map()`), `[id].ts`.
- **Problem:** A second, parallel timers API that stores to a per-process in-memory Map (lost on every restart) and never touches SQLite. Real timer persistence is the TanStack Start server fns in `apps/web` (`timer-sync.server.ts`). Confusing dead surface; if any client hits it, those writes vanish on restart.
- **Fix:** Delete the unused Nitro timers routes (and `sync/upload`) — confirm no client calls `/api/timers` first.

### P2-4 — `createdAt`/`updatedAt` are `notNull()` with NO SQL default — every insert path must supply them
- **Where:** schema `apps/web/src/drizzle/schema.ts` — all tables use `createdAt: text("created_at").notNull()` / `updatedAt: text(...).notNull()` with no `.default(...)`. Insert paths that pass raw client `data`: `assistant.server.ts:112` (`db.insert(assistantTasks).values(data)`), `bookmarks.server.ts:50` (`db.insert(bookmarks).values(data)`), and the ~13 other `db.insert(...).values(data).returning()` calls in `assistant.server.ts`.
- **Problem:** The server handlers do **not** inject timestamps server-side — they forward the client-supplied object straight to `.values(data)`. Persistence currently depends entirely on every call site (e.g. `mcp/tools/tasks.ts:53-63` and the assistant `useHandoff`/`useCelebrations`/`useBlockers` hooks) remembering to set `createdAt`/`updatedAt`. Today's call sites do set them, so this is not currently broken — but it is fragile: any new caller (or a future client/MCP tool) that omits them gets a `NOT NULL constraint failed` at insert time, or, if a column were ever made nullable, silently-null timestamps that break `orderBy(desc(updatedAt))` listings. `timer-sync.server.ts` and `notes.server.ts` *do* set them server-side — the inconsistency itself is the risk.
- **Fix:** Inject `createdAt`/`updatedAt` (and `version`) **server-side** in every create handler (`{ ...data, createdAt: now, updatedAt: now }`), and have `update*` handlers always overwrite `updatedAt` (the assistant `update*` handlers already do — make `create*` symmetric). Optionally add `.$defaultFn(() => new Date().toISOString())` in the schema as a backstop. Standardize so no call site is trusted to supply timestamps.

---

## Summary of state

- **Schema:** `apps/web/src/drizzle/schema.ts` — 1 timer table (with `version` integer for optimistic concurrency, real and enforced in `mutate()`), `activity_logs`, ~16 assistant tables, `notes`, `bookmarks`, `ai_conversations`, `ai_messages`. All `userId`-indexed. Timestamps are `text().notNull()` with no default (see P2-4).
- **Timer hardening (claimed prior effort):** **Real.** `version` column exists (`schema.ts:53`, migration `0001_add_timer_version.sql`); `mutate()` enforces `expectedVersion` and `UPDATE … WHERE id=? AND version=?` with `changes===0 → TimerConflict`; state-machine via `applyAction`. Gap: not wrapped in a transaction (P1-1), and the version check is **timer-only** — assistant/notes/bookmarks mutations have no optimistic concurrency (last-write-wins, acceptable for trusted group but note it).
- **Migrations:** Files exist (`0000`–`0005`), but **no runtime runner** — manual `drizzle-kit migrate` only (P0-3).
- **Backups:** **None** (P0-2).
- **Concurrency:** WAL on, `foreign_keys` on, but **no `busy_timeout`** and **no transactions** around multi-statement writes (P1-1/P1-2). Cluster mode would break state (P1-3).
- **Dead/footgun surfaces:** `server-db.ts`, `/api/sync/upload`, `/api/timers` (P2-1/2/3).
