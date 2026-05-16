# dev-dashboard v2 ("Pulse") — Design Spec

**Date:** 2026-05-15
**Branch:** `feat/dev-dashboard`
**Builds on:** `2026-05-15-dev-dashboard.design.md` (v1: ttyd, cmux, obsidian)

## Goal

Add five new panels to the personal dev dashboard at `mac.foltyn.dev`, all in the same Slate-Grid theme and behind the same Cloudflare-Access gate:

1. **System Pulse** — live snapshot + graphs of the Mac itself (CPU, memory, swap, battery, disk, Wi-Fi, public IP, top RAM hogs) **plus** a Weather widget (current temp, condition, sunrise, sunset).
2. **Claude Usage** — web view of the data already collected by `tools claude usage` / `tools claude daemon`. Same library, different UI.
3. **Daemon** — `tools daemon` status, registered tasks, recent runs, click-through to log entries.
4. **Containers** — Docker / OrbStack containers (`docker ps`-backed) with status, ports, CPU/mem if cheap.
5. **Todos** — Apple-Reminders-backed list with add/complete/delete. Default list `GenesisTools`. List picker for switching.

System Pulse becomes the new `/` (home). The v1 welcome card moves to a top strip on the same page.

## Non-goals

- **No new data store for Claude Usage.** Read directly from the existing `~/.genesis-tools/claude/*.db` populated by `tools claude daemon`. If the daemon hasn't been installed, the panel shows a "Run `tools claude daemon install` to start polling" CTA — it does NOT silently start polling from inside the dashboard.
- **No new daemon for system pulse polling** — the dashboard's own background poller writes to a small SQLite at `~/.genesis-tools/dev-dashboard/pulse.db`. Started in `vite-middleware.ts` on first load, same pattern as the existing cmux poller.
- **No write to Cloudflare** — Containers panel is read-only. Todos panel is the only write surface; it writes via the existing `MacReminders` lib which uses JXA / EventKit. No new entitlements.
- **No realtime push (SSE/WS)** — TanStack Query polling on a 2-30s cadence per panel. Keeps the middleware simple.

## Architecture

Same shell as v1: Bun runs the `tools dev-dashboard` entrypoint, which spawns Vite on port 3042. Custom Vite middleware exposes REST endpoints; React routes consume them via TanStack Query.

```
src/dev-dashboard/
├── lib/
│   ├── system/         NEW   pulse collector + history DB + poller
│   ├── weather/        NEW   Open-Meteo client (no key)
│   ├── containers/     NEW   docker/orbstack ps parser
│   ├── claude-usage/   NEW   thin aggregator over @app/claude/lib/usage/*
│   ├── daemon-view/    NEW   thin aggregator over @app/daemon/lib/*
│   ├── todos/          NEW   thin wrapper over @app/utils/macos/apple-reminders
│   ├── ttyd/           v1
│   ├── cmux/           v1
│   ├── obsidian/       v1
│   └── auth.ts         v1
├── ui/src/
│   ├── routes/
│   │   ├── __root.tsx          MODIFY  (sidebar entries)
│   │   ├── index.tsx           MODIFY  (becomes Pulse page)
│   │   ├── claude.tsx          NEW
│   │   ├── daemon.tsx          NEW
│   │   ├── containers.tsx      NEW
│   │   ├── todos.tsx           NEW
│   │   └── (ttyd|cmux|obsidian).tsx   v1
│   └── components/
│       ├── pulse/      KpiCard, PulseGraph, ProcessTable, NetworkInfo, WeatherCard
│       ├── claude-usage/ AccountCard, BucketBar, UsageChart
│       ├── daemon/     DaemonHeader, TasksTable, RunsTimeline, LogModal
│       ├── containers/ ContainersTable
│       ├── todos/      TodoList, AddTodoForm, ListPicker
│       └── Sidebar.tsx          MODIFY
├── vite-middleware.ts           MODIFY  (+ ~12 endpoints)
└── config.ts                    MODIFY  (+ weatherCoords, todoListName, pulseRetentionHours)
```

## Reused libs (do NOT reimplement)

- `@app/claude/lib/usage/api.ts` — `fetchAllAccountsUsage()` returns `AccountUsage[]` with per-bucket utilization + resets_at.
- `@app/claude/lib/usage/history-db.ts` — `UsageHistoryDb` with `getSnapshots(account, bucket, lastMinutes)`. Already populated by `tools claude daemon`.
- `@app/daemon/lib/config.ts` — `loadConfig()` → `DaemonConfig` with `tasks[]`.
- `@app/daemon/lib/launchd.ts` — `getDaemonStatus()` → `{ installed, running, pid }`.
- `@app/daemon/lib/log-reader.ts` — `listTasksWithLogs(baseDir)`, `listRunsForTask(baseDir, name)`, `parseLogFile(path)`.
- `@app/utils/macos/apple-reminders.ts` — `MacReminders.{listLists, listReminders, searchReminders, createReminder, completeReminder, deleteReminder, ensureListExists}`.

## Data sources

**System Pulse** (collected in-dashboard, polled every 5s):
- CPU%: `top -l 1 -n 0` → parse `CPU usage: A user, B sys, C idle` → `100 - idle`.
- Memory: `vm_stat` + `sysctl hw.memsize`. `usedBytes = (active + wired + compressed) * pageSize`.
- Swap: `sysctl vm.swapusage` → reuse `parseSwapUsage()` from `src/macos/lib/swap/scanner.ts`.
- Battery: `pmset -g batt` → parse `\d+%; (charging|discharging|charged)`.
- Disk: `df -k /` → free bytes on root.
- Wi-Fi SSID: `networksetup -getairportnetwork en0` (en0 fallback to airport detection).
- Public IP: `ipify.org` JSON API, cached 5 min in pulse.db.
- Top processes: reuse `parsePsOutput()` from `src/macos/lib/swap/scanner.ts`, take top 5 by RSS.

**Weather** (polled every 10 min):
- Open-Meteo `https://api.open-meteo.com/v1/forecast` with `current=temperature_2m,weather_code` and `daily=sunrise,sunset`. No API key. Default coords Prague `50.0755, 14.4378`, overridable via config.

**Claude Usage** (read on every request, no caching):
- `fetchAllAccountsUsage()` for current state.
- `UsageHistoryDb.getSnapshots(account, bucket, lastMinutes)` for time-series.

**Daemon** (read on every request):
- `getDaemonStatus()` + `loadConfig()` for status.
- `listTasksWithLogs` + `listRunsForTask` for recent runs.
- `parseLogFile(path)` for a single run's entries.

**Containers** (read every 5s):
- `docker ps -a --format '{{json .}}'` — works on Docker Desktop and OrbStack (both ship `docker` CLI). If `docker` is not on PATH, return empty + a "Docker not detected" flag so UI can render the empty state.

**Todos** (read on every request):
- `MacReminders.listReminders({ listName, includeCompleted: false })`.
- `MacReminders.listLists()` for the list picker.

## HTTP endpoints (in `vite-middleware.ts`)

All JSON responses go through `SafeJSON.stringify`. All are guarded by `requireDashboardAuth` (basic auth) and behind CF Access (`martin@foltyn.dev`).

```
GET  /api/system/pulse                       → PulseSnapshot
GET  /api/system/pulse/history?metric=cpu&minutes=60   → PulseSeries (points[])
GET  /api/weather                            → WeatherSnapshot
GET  /api/claude/usage                       → AccountUsage[]
GET  /api/claude/usage/history?account=X&bucket=Y&minutes=1440   → UsageSnapshot[]
GET  /api/daemon/status                      → DaemonStatusResponse
GET  /api/daemon/runs?task=X&limit=20        → RunSummary[]
GET  /api/daemon/runs/log?logFile=<path>     → LogEntry[]
GET  /api/containers                         → { dockerAvailable: boolean, containers: ContainerInfo[] }
GET  /api/todos?list=GenesisTools            → { lists: ReminderListInfo[], reminders: ReminderInfo[] }
POST /api/todos                              body { title, listName?, due?, priority?, notes? } → { reminderId }
POST /api/todos/complete                     body { reminderId } → { ok: true }
DELETE /api/todos                            body { reminderId } → { ok: true }
```

## UI routes

- `/` — **Pulse** (was empty welcome card). Top KPI strip + two graphs + side widgets (Weather, Network, Top procs).
- `/claude` — Claude Usage panel.
- `/daemon` — Daemon panel.
- `/containers` — Containers panel.
- `/todos` — Todos panel.
- `/ttyd`, `/cmux`, `/obsidian` — v1, unchanged.
- `/share/:slug` — v1, public.

Sidebar gets six entries instead of three. Order: Pulse (home icon), Claude, Daemon, Containers, Todos, ttyd, cmux, obsidian. Active route highlighted with the slate-grid accent gradient.

## Theme & components

Reuse `slate-grid.css` tokens (`--dd-bg-base`, `--dd-bg-panel`, `--dd-border`, `--dd-accent-gradient`, `--dd-text`, `--dd-text-dim`). Charts via `recharts` (already a root dep) with axis/grid recolored to slate tokens. KPI cards: 1×4 grid on desktop, 2×2 on mobile.

## Polling cadence summary

- Pulse: snapshot 2s, history graphs 10s.
- Weather: 10min.
- Claude Usage: 30s (cheap — just reads local DB).
- Daemon status/tasks/runs: 5s.
- Containers: 5s.
- Todos: 10s.

## Config additions (Zod schema in `config.ts`)

```ts
const WeatherCoordsSchema = z.object({
    latitude: z.number().default(50.0755),
    longitude: z.number().default(14.4378),
    label: z.string().default("Prague"),
});
const PulseConfigSchema = z.object({
    retentionHours: z.number().int().min(1).default(24),
    pollIntervalMs: z.number().int().min(1000).default(5000),
});
// Added to DevDashboardConfigSchema:
weatherCoords: WeatherCoordsSchema.default({}),
pulse: PulseConfigSchema.default({}),
todoListName: z.string().default("GenesisTools"),
```

## Error handling

- Pulse collector: any single metric that fails returns `null` for that field (others still surface). UI renders `—` for nulls.
- Weather: 5s fetch timeout; on failure return a `WeatherSnapshot` with `error: "fetch failed"` and the last cached value if any.
- Claude Usage: if the local DB has zero rows for the requested account/bucket window, return `{ snapshots: [], hint: "Run 'tools claude daemon install' to start polling." }`.
- Daemon: if the daemon is not installed, status returns `{ installed: false, running: false }` and tasks list is still readable.
- Containers: if `docker` is not on PATH, return `{ dockerAvailable: false, containers: [] }`.
- Todos: if `MacReminders.ensureAuthorized()` rejects, the API returns 503 with `{ error: "Reminders permission denied. Grant in System Settings → Privacy & Security → Reminders." }`.

## Testing

Each new lib subdir gets a `*.test.ts` covering parse/aggregation logic with fixtures. UI components are exercised by manually opening the routes against a running middleware (no UI test runner is configured in this repo for dev-dashboard).

## Out of scope (deferred to v3)

- Push notifications / SSE.
- Cross-machine pulse (only this Mac).
- Docker stats (CPU/mem per container) — `docker stats` is expensive; v2 lists containers only.
- Mobile-only layout polish (basic responsive only).
- Todos editing of existing reminders (only add/complete/delete).
