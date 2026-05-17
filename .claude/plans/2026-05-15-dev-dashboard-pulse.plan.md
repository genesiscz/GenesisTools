# dev-dashboard v2 ("Pulse") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add six panels (System Pulse, Weather, Claude Usage, Daemon, Containers, Todos) to the dev-dashboard at `mac.foltyn.dev`, matching the v1 Slate-Grid conventions.

**Architecture:** Same shell as v1 — `tools dev-dashboard` spawns Vite on :3042; `vite-middleware.ts` exposes REST endpoints; TanStack-Query React routes consume them. Each panel = isolated `lib/<panel>/` data layer + `ui/src/components/<panel>/` + `ui/src/routes/<panel>.tsx`. Shared wiring (config, api client, middleware endpoints, router, sidebar) is integrated centrally.

**Tech Stack:** Bun, TypeScript, React 19, TanStack Router/Query, recharts, Zod, `Storage`, `bun:sqlite`, `MacReminders`, reused `@app/claude/lib/usage/*` + `@app/daemon/lib/*` + `@app/macos/lib/swap/scanner`.

**Source of truth:** `.claude/plans/2026-05-15-dev-dashboard-pulse.design.md` (committed). This plan only decomposes it.

---

## Phase 0 — Shared scaffolding (sequential, integrator-owned)

### Task 0.1: Config additions
**Files:** Modify `src/dev-dashboard/config.ts`
- [ ] Add `WeatherCoordsSchema`, `PulseConfigSchema`; add `weatherCoords`, `pulse`, `todoListName` to `DevDashboardConfigSchema` (defaults per design §Config).
- [ ] `bun test src/dev-dashboard/lib/auth.test.ts` still green (config import path unchanged).

### Task 0.2: API client contracts
**Files:** Modify `src/dev-dashboard/ui/src/lib/api.ts`
- [ ] Add `systemApi`, `weatherApi`, `claudeUsageApi`, `daemonApi`, `containersApi`, `todosApi` covering every endpoint in design §HTTP endpoints, typed against the per-panel `types.ts` files.

### Task 0.3: Middleware endpoints
**Files:** Modify `src/dev-dashboard/ui/vite-middleware.ts`
- [ ] Add the 12 endpoints from design §HTTP endpoints, each delegating to the panel lib. Pulse poller started on first load (mirror existing cmux `startPolling`).

### Task 0.4: Router + Sidebar
**Files:** Modify `src/dev-dashboard/ui/src/router.tsx`, `src/dev-dashboard/ui/src/components/Sidebar.tsx`
- [ ] Register `/claude`, `/daemon`, `/containers`, `/todos` routes; index stays `/` (Pulse). Add sidebar entries (icons: Activity, Bot, Timer, Container, ListTodo) in order Pulse, Claude, Daemon, Containers, Todos, ttyd, cmux, obsidian.

---

## Phase 1 — System Pulse + Weather (Agent A)

### Task 1.1: Types
**Files:** Create `src/dev-dashboard/lib/system/types.ts`, `src/dev-dashboard/lib/weather/types.ts`
- [ ] `PulseSnapshot` (cpuPct, memUsedBytes, memTotalBytes, swapUsedBytes, swapTotalBytes, batteryPct, batteryState, diskFreeBytes, diskTotalBytes, wifiSsid, publicIp, topProcesses[], capturedAt — all nullable except capturedAt).
- [ ] `PulsePoint` `{ ts: string; value: number }`, `PulseSeries` `{ metric: string; points: PulsePoint[] }`.
- [ ] `WeatherSnapshot` `{ tempC, weatherCode, description, sunrise, sunset, label, fetchedAt, error? }`.

### Task 1.2: Collector (TDD)
**Files:** Create `src/dev-dashboard/lib/system/collector.ts`, `collector.test.ts`
- [ ] Pure parsers: `parseCpuIdle(topOut)`, `parseVmStat(out, pageSize)`, `parseBattery(pmsetOut)`, `parseDfRoot(dfOut)`, `parseWifiSsid(out)`. Reuse `parseSwapUsage`, `parsePsOutput` from `@app/macos/lib/swap/scanner`.
- [ ] `collectPulse(): Promise<PulseSnapshot>` runs the shell cmds via `Bun.spawn`, each wrapped so a failure → that field `null`.
- [ ] Tests cover every parser with fixture strings (real `top`/`vm_stat`/`pmset`/`df`/`networksetup` samples). Verify fail → impl → pass.

### Task 1.3: History DB (TDD)
**Files:** Create `src/dev-dashboard/lib/system/history-db.ts`, `history-db.test.ts`
- [ ] `PulseHistoryDb` over `bun:sqlite` at `~/.genesis-tools/dev-dashboard/pulse.db` (use `Storage("dev-dashboard")` dir). Schema `pulse_points(metric TEXT, ts TEXT, value REAL)`. `record(metric, value)`, `series(metric, minutes)`, `pruneOlderThan(hours)`, plus a public-IP cache row.
- [ ] In-memory `new Database(":memory:")` test for record/series/prune.

### Task 1.4: Poller
**Files:** Create `src/dev-dashboard/lib/system/poller.ts`
- [ ] `startPulsePolling(intervalMs)` — singleton interval, `collectPulse()` → write cpu/mem/swap/battery to history-db, prune on each tick. `getCachedPulse()` returns last snapshot.

### Task 1.5: Pulse UI
**Files:** Create `ui/src/components/pulse/{KpiCard,PulseGraph,ProcessTable,NetworkInfo,WeatherCard}.tsx`; rewrite `ui/src/routes/index.tsx`
- [ ] KPI strip (CPU/Mem/Swap/Battery), two recharts area graphs (cpu+mem, 30m), side column Weather + Network + Top procs. Slate-grid tokens. Polls snapshot 2s, history 10s, weather 10min.

### Task 1.6: Weather client (TDD)
**Files:** Create `src/dev-dashboard/lib/weather/client.ts`, `client.test.ts`
- [ ] `fetchWeather(coords)` → Open-Meteo, 5s `AbortSignal.timeout`, map `weather_code`→description, on failure return `{ error }` + null fields. Test the code→description map + the parse of a captured Open-Meteo JSON fixture (no network in test).

---

## Phase 2 — Claude Usage (Agent C)

### Task 2.1: Types + aggregator (TDD)
**Files:** Create `src/dev-dashboard/lib/claude-usage/{types,aggregator}.ts`, `aggregator.test.ts`
- [ ] `getCurrentUsage()` → wrap `fetchAllAccountsUsage()`. `getUsageHistory(account,bucket,minutes)` → wrap `UsageHistoryDb.getSnapshots`; when empty return `{ snapshots: [], hint }`. Test the empty→hint branch with an in-memory `UsageHistoryDb(":memory:")`.

### Task 2.2: Claude UI
**Files:** Create `ui/src/components/claude-usage/{AccountCard,BucketBar,UsageChart}.tsx`, `ui/src/routes/claude.tsx`
- [ ] Per-account cards with per-bucket % bars + resets-in countdown; recharts line of utilization (24h). Empty state renders the hint CTA. Poll 30s.

---

## Phase 3 — Daemon (Agent D)

### Task 3.1: Aggregator (TDD)
**Files:** Create `src/dev-dashboard/lib/daemon-view/{types,aggregator}.ts`, `aggregator.test.ts`
- [ ] `getDaemonOverview()` → `{ status: getDaemonStatus(), tasks: loadConfig().tasks }`. `getRecentRuns(task,limit)` → `listRunsForTask(getLogsBaseDir(), task)`. `getRunLog(logFile)` → `parseLogFile`. Test a fixture-driven `parseLogFile` round-trip (write a temp `.jsonl`, parse, assert entries).

### Task 3.2: Daemon UI
**Files:** Create `ui/src/components/daemon/{DaemonHeader,TasksTable,RunsTimeline,LogModal}.tsx`, `ui/src/routes/daemon.tsx`
- [ ] Status header (running/installed/stopped + PID), tasks table, recent-runs strip (exit-code colored), click → LogModal of parsed entries. Poll 5s.

---

## Phase 4 — Containers (Agent E)

### Task 4.1: Docker parser (TDD)
**Files:** Create `src/dev-dashboard/lib/containers/{types,docker}.ts`, `docker.test.ts`
- [ ] `ContainerInfo` `{ id, name, image, state, status, ports }`. `listContainers()` → `Bun.spawn(["docker","ps","-a","--format","{{json .}}"])`; if spawn ENOENT → `{ dockerAvailable:false, containers:[] }`. `parseDockerPsJsonl(stdout)` pure → test with a captured 3-line jsonl fixture incl. a stopped container.

### Task 4.2: Containers UI
**Files:** Create `ui/src/components/containers/ContainersTable.tsx`, `ui/src/routes/containers.tsx`
- [ ] Table (name, image, state dot, status, ports). `dockerAvailable:false` → "Docker / OrbStack not detected" empty state. Poll 5s.

---

## Phase 5 — Todos (Agent F)

### Task 5.1: Service (TDD)
**Files:** Create `src/dev-dashboard/lib/todos/{types,service}.ts`, `service.test.ts`
- [ ] Thin wrap of `MacReminders`: `listTodos(listName)`, `listTodoLists()`, `addTodo({title,listName,due?,priority?,notes?})`, `completeTodo(id)`, `deleteTodo(id)`. `mapPriority(level)` pure (high/medium/low/none → `ReminderPriority`) — unit test that map (no EventKit in test).

### Task 5.2: Todos UI
**Files:** Create `ui/src/components/todos/{TodoList,AddTodoForm,ListPicker}.tsx`, `ui/src/routes/todos.tsx`
- [ ] List with complete (checkbox) + delete; add form (title, optional due/priority); list picker. Optimistic invalidate on mutate. Poll 10s. 503 → permission CTA.

---

## Phase 6 — Integration & verification (sequential)

### Task 6.1: Wire everything
- [ ] Confirm Tasks 0.2–0.4 reference the real exported symbols from every panel `types.ts`. `bunx tsc --noEmit` clean for non-ui (`src/dev-dashboard/ui` is tsconfig-excluded; lib must typecheck).

### Task 6.2: Tests + restart + smoke
- [ ] `bun test src/dev-dashboard/` all green.
- [ ] Restart Vite; curl each endpoint locally; load `/`, `/claude`, `/daemon`, `/containers`, `/todos` via the tunnel; confirm 200 + expected shape.

### Task 6.3: Commit
- [ ] One `feat(dev-dashboard)` commit; voice notification.

## Self-Review

- Spec coverage: every design §Goal panel + §HTTP endpoint + §Config field has a task. ✓
- Type consistency: each panel's `types.ts` is the single source the api client + middleware + components import. ✓
- No placeholders: parsers are pure + fixture-tested; UI exercised via curl/tunnel (no UI test runner per design §Testing). ✓
