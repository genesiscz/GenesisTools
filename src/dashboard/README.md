# Dashboard

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **Personal productivity dashboard — timer, assistant tasks, focus, planner, and a public Obsidian share, in one local-first web app.**

A TanStack Start (React 19) app backed by a single on-disk SQLite database. The server is the source of truth; the browser holds no database. Launched and managed through `tools dashboard`.

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Pulse** | At-a-glance panels: System, Weather, Claude usage, Daemon, Containers, Todos |
| **Timer** | Stopwatch / countdown / Pomodoro with cross-tab + cross-device sync |
| **Assistant** | Tasks, decisions, context parking, blockers, handoffs, communication logs |
| **Focus & Planner** | Pomodoro focus sessions and a day-view task timeline |
| **Public share** | Read-only Obsidian note renderer at `/share/:slug` |
| **ttyd tunnel** | Terminal-over-web, proxied to work over the Cloudflare tunnel / mobile |

---

## Quick Start

```bash
# Start the dev server and open the browser (auto-installs deps if missing)
tools dashboard

# Production build + PM2 (ecosystem.config.cjs)
tools dashboard --prod

# Force a fresh dependency install before starting
tools dashboard --reinstall

# Custom port, no auto-open
tools dashboard --port 3001 --no-open
```

First run with no `node_modules` triggers `bun install` automatically. Pass `--no-install` to opt out (it then errors instead of installing).

---

## Launcher Flags

| Flag | Description |
|------|-------------|
| `--prod` | Production build, then run via PM2 instead of the Vite dev server |
| `--reinstall` | Force `bun install` before starting |
| `--no-install` | Do not auto-install when `node_modules` is missing (error instead) |
| `--no-open` | Start the server but don't open a browser |
| `-p, --port <n>` | Port to wait on / open (default `3000`) |

---

## How it works

- **Workspace**: a bun + Turborepo monorepo. `apps/web` is the real app (TanStack Start on an embedded Nitro server, Node 22 SSR — not Bun). `packages/shared` holds shared utilities (`SafeJSON`, …).
- **Database**: Drizzle ORM over `better-sqlite3` — **synchronous**, WAL mode, file at `SQLITE_PATH` (default `.data/dashboard.sqlite`, absolute required in prod). Migrations auto-apply at server start; a failed migration refuses to serve. See `apps/web/.claude/docs/systems/database.md`.
- **Realtime**: two complementary layers — a per-user in-memory **SSE domain event bus** (`/api/events`, cross-device) and **BroadcastChannel** (same-device tabs). Both just nudge TanStack Query to refetch. See `apps/web/.claude/docs/systems/events.md`.
- **Production**: `bun run build:prod` (`vite build` → Nitro output) and PM2 via `ecosystem.config.cjs`. See `DEPLOY.md`.
- **Auth**: WorkOS (`@workos-inc/node`); env via `@t3-oss/env-core`. No-auth dev fallback uses `dev-user`.

---

## Layout

```
src/dashboard/
├─ index.ts                 # `tools dashboard` launcher (commander)
├─ apps/web/                # the app — TanStack Start + Drizzle + SQLite
│  └─ .claude/docs/         # architecture docs (database, events)
├─ packages/shared/         # shared lib (SafeJSON, types)
├─ packages/typescript-config/
├─ ecosystem.config.cjs     # PM2 (production)
└─ DEPLOY.md                # production build + deploy notes
```

---

## Related

- `tools dashboard` — the launcher (this package's entry point)
- `apps/web/.claude/CLAUDE.md` — architecture summary + context triggers for agents
