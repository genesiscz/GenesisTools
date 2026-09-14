# 20 — Remaining Features (claude-usage / daemon / containers / weather) implementation notes

> Worktree off `feat/dev-dashboard-mobile` @ `10981acc5`, committed directly. All work scoped to
> `DevDashboard/mobile/`. `src/api/*`, `src/ui/*`, the contract (`src/dev-dashboard/contract/*`),
> `DECISIONS.md`, the tabs `_layout.tsx`, and other `src/features/*` were NOT touched (read/consume
> only). No Metro / `expo start` / simulator / `expo run` was started — device builds + Appium runs
> are the user's job.

## Status: COMPLETE — 4 feature folders + 4 screens + a self-contained `(more)` Stack layout +
## per-feature query/hook tests + Appium Page Objects & a combined smoke spec, all committed.

- **`bunx tsc --noEmit` (app):** 0 errors (fully clean — see the SETUP note below; an earlier
  "2 tweetnacl errors" reading was an UNINSTALLED-WORKTREE-ROOT artifact, not a code defect).
- **`bun test src/`:** 81 pass / 0 fail across 22 files (55 foundation + 26 of mine).
- **`bun test src/features/{weather,claude-usage,daemon,containers}`:** 26 pass / 0 fail across 8
  files (4 new query tests + 4 new units tests). Each feature also passes in isolation.
- **`bunx tsc -p e2e/tsconfig.json`:** 0 errors (Appium Page Objects + spec type-check).

> **SETUP GOTCHA (resolved):** this isolated worktree needs `bun install` at BOTH the worktree ROOT
> AND `DevDashboard/mobile/`. `src/dev-dashboard/lib/e2e/box.ts` (repo-root tree, reached via the
> contract barrel) imports `tweetnacl`/`tweetnacl-util`, which metro/tsc/bun resolve from
> `workspaceRoot/node_modules`. Installing only inside `DevDashboard/mobile/` leaves the root
> `node_modules` empty → 2 spurious `TS2307` errors + 1 "Cannot find package 'tweetnacl'" test error.
> After `bun install` at the worktree root (puppeteer's postinstall browser-download fails on the
> sandboxed network — non-fatal, ignore), all of the above goes green. NOT a foundation/dep defect.
- Use `bunx tsc` NOT `tsgo` for the mobile app (tsgo can't resolve RN's `types` export condition —
  plan-05 notes #13). `expo lint` / Appium specs NOT run (no sim).

## Commits (one per feature area)

| Step | Commit | Subject |
|---|---|---|
| weather | `3df54b543` | weather feature (compact card + per-feature queries/hooks) + `(more)` Stack layout |
| claude-usage | `fb6dc739b` | claude-usage feature (account cards + per-bucket burn-down MetricCharts + range) |
| daemon | `496bc0c7f` | daemon feature (status header + runs list + run-log sheet) |
| containers | (this batch) | containers feature (docker availability + running/stopped rows) |
| e2e + notes | (this batch) | Appium Page Objects + combined smoke spec + these notes |

## What was built (per the pulse-notes #16 D32 per-feature pattern)

Each feature is a self-contained folder under `src/features/<x>/`:
`queries.ts` (co-located `<x>Keys` + TanStack-v5 `queryOptions` FACTORIES over the injected
`DashboardClient`) → `hooks.ts` (thin `use*` one-liners, `useQuery(xQuery(useDashboardClient()))`)
→ `units.ts` (pure local formatters/mappers, no `@app/*` import) → `components/` (presentational,
consume the per-feature hooks — NEVER raw `useQuery`, D32). Screens compose the components.

- **weather** — `client.weather()` (a direct typed method, not the escape hatch). Compact
  `WeatherCard` (temp / description / label / sunrise-sunset). KEY-ROOT decision below.
- **claude-usage** — `client.get<AccountUsage[]>(paths.claudeUsage())` +
  `client.get<MultiBucketHistoryResult>(paths.claudeUsageHistory(...))` via the escape hatch.
  Per-account `AccountUsageCard` (5h/7d/Sonnet-7d %) + `AccountHistoryCharts` rendering ONE shared
  `MetricChart` per bucket (token burn-down), with a 1h/24h/7d `RangeSelector`. `historyToBucketSeries`
  maps `MultiBucketHistoryResult` → per-bucket `MetricPoint[]` (`Date.parse(timestamp)`→ts,
  `utilization*100`→value, drops NaN).
- **daemon** — `client.get<DaemonOverview>(paths.daemonStatus())`,
  `client.get<RunSummary[]>(paths.daemonRuns({limit}))`,
  `client.get<LogEntry[]>(paths.daemonRunLog(logFile))`. `DaemonStatusHeader` (running/stopped/
  not-installed pill + PID + task counts), `RunRow` (outcome dot + duration, tap to open),
  `RunLogSheet` (Modal fetching the run's structured log via `useDaemonRunLog`).
- **containers** — `client.get<ContainersResult>(paths.containers())`. Docker-availability card +
  running/stopped sections of `ContainerRow` (name + state pill + image + status + ports).

### Screens & navigation — `src/app/(more)/`

Created a **self-contained `(more)` route group** with its OWN `_layout.tsx` (a `Stack`), plus
`weather.tsx`, `claude-usage.tsx`, `daemon.tsx`, `containers.tsx`. expo-router v55 auto-treats each
file in the group as an eligible route in this Stack — no per-screen registration needed there. This
deliberately AVOIDS touching the tabs `_layout.tsx` (owned by the orchestrator / other agents) and
`more.tsx` (a `TabPlaceholder`).

**► ORCHESTRATOR CONSOLIDATION TODO (navigation registration):** to surface these from the tab bar,
the consolidation pass must link the `(more)` routes from the existing `more` tab (or add a `(more)`
group entry) in `src/app/(tabs)/_layout.tsx` / replace `more.tsx`'s placeholder with a menu linking
to `/claude-usage`, `/daemon`, `/containers`, `/weather`. The routes are reachable by those hrefs
once linked. Screen-root testIDs: `screen-weather`, `screen-claude-usage`, `screen-daemon`,
`screen-containers`.

## Decisions & deviations (and why)

1. **Skipped plan-09 Tasks 1–3 (contract DTOs/endpoints/client).** Those edit
   `src/dev-dashboard/contract/*` — OUT of scope (`DevDashboard/mobile/` only) AND already shipped:
   the contract already exports `AccountUsage`, `DaemonOverview`, `RunSummary`, `ContainerInfo`/
   `ContainersResult`, `WeatherSnapshot`, `MultiBucketHistoryResult`, `LogEntry`, the `paths.*`
   builders, and the generic `client.get<T>`/`client.post<T>` escape hatch + `client.weather()`.
   We CONSUME them. (plan-09 predates the shipped contract; pulse-notes #16 is the current pattern.)
2. **`MetricChart` is single-series, not plan-09's `{series:[...]}` multi-line shape.** The shipped
   `src/ui/MetricChart.tsx` takes `{ title, points: MetricPoint[]{ts,value}, unit, domain, variant,
   formatX, testID }`. So claude-usage renders ONE chart per bucket instead of one multi-line chart
   — exactly the "adapt the mappers, not the chart" path plan-09 anticipated.
3. **Weather key-root.** Pulse already owns the `["weather"]` root (`pulseKeys.weather`) over the
   same `client.weather()` endpoint. To keep the D32 unique-root rule (each feature leads with a
   distinct root) and independent invalidation, the weather feature uses `["weather-card","snapshot"]`.
   Cost: one extra `client.weather()` fetch if both Pulse's weather block and a standalone weather
   card mount at once — negligible at a 10-min poll. (React Query would dedupe an identical key, but
   distinct roots are the correct D32 convention for parallel-owned features.)
4. **Weather is a CARD, not a tab.** It gets a focused `(more)/weather.tsx` screen for completeness +
   Appium, but it is NOT counted as a tab and does not compete with Pulse's own weather card.
5. **`UsageBucket` derived, not imported.** The contract re-exports `AccountUsage` but NOT the
   underlying `UsageBucket`. Rather than extend the (read-only) contract, `units.ts` derives it as
   `NonNullable<NonNullable<AccountUsage["usage"]>["five_hour"]>` — stays in lockstep, zero contract edit.
6. **Local formatters per feature** (no `@app/*`, no cross-feature import). Each feature owns its
   `units.ts` (`temp`/`clock`, `utilizationPct`/`historyToBucketSeries`, `duration`/`runOutcome`/
   `logLineText`, `runState`/`partitionByState`/`shortImage`) so parallel agents never collide.

## ⚠️ FLAGS — shared mock gaps (NOT fixed; `mock-client.ts` is shared/read-only per the brief)

These are handled defensively in the feature query factories (guards), and asserted in the tests,
so screens render an empty state under the mock instead of crashing. A device with a real Agent
returns the correct shapes. **Flagging for the orchestrator to fix in `mock-client.ts` if richer
parallel-dev fixtures are wanted:**

- **`/api/claude/usage/history` returns the WRONG shape under the mock.** The mock's `escapeHatch`
  checks `path.startsWith(paths.claudeUsage())` = `/api/claude/usage` FIRST, and `/api/claude/usage/
  history` is a prefix-match, so it returns `[MOCK_USAGE]` (an `AccountUsage[]`) instead of a
  `MultiBucketHistoryResult`. The mock's own comment (lines 252–257) already notes this and asks a
  claude-usage agent to add a `/history` branch before the `claudeUsage` branch. GUARD:
  `usageHistoryQuery`'s `asHistory()` coerces a non-`series` payload to `{ series: [] }`.
  **Suggested mock fix:** add, BEFORE the `claudeUsage` branch, a
  `if (path.startsWith(paths.claudeUsageHistory({}).split("?")[0]))` branch returning a
  `MultiBucketHistoryResult` fixture (a couple of `BucketSeries` with a few `UsageSnapshot`s).
- **`/api/daemon/runs` and `/api/daemon/runs/log` fall through to `{}`.** The mock only branches on
  `/api/daemon/status`; the runs/log routes do NOT prefix-match it, so they hit the catch-all `{}`
  (an object, NOT an array). GUARD: `daemonRunsQuery`/`daemonRunLogQuery` `asArray()` coerce to `[]`.
  **Suggested mock fix:** add `/api/daemon/runs` (→ `RunSummary[]`) and `/api/daemon/runs/log`
  (→ `LogEntry[]`) branches so the daemon runs list + log sheet show life under the mock.

## RESOLVED — the `tweetnacl` "baseline" was an uninstalled worktree root (NOT a code defect)

An earlier reading showed 2 `TS2307` + 1 "Cannot find package 'tweetnacl'" test error from
`src/dev-dashboard/lib/e2e/box.ts`. **Root cause: this isolated worktree's ROOT `node_modules` was
never populated** — I had only run `bun install` inside `DevDashboard/mobile/`. `box.ts` (repo-root
tree, reached via the contract barrel) resolves `tweetnacl`/`tweetnacl-util` from
`workspaceRoot/node_modules`. After `bun install` at the worktree root, `bun test src/` is
**81 pass / 0 fail** and `bunx tsc --noEmit` is **0 errors**. So this is NOT a foundation/dep gap to
"hoist" — just a two-place install requirement for isolated worktrees (documented in the SETUP
GOTCHA up top). Nothing for the orchestrator to fix here.

## ⚠️ FLAG — `(more)` group sits OUTSIDE the auth `Stack.Protected` guard

The `(more)` route group is a ROOT-level sibling of `(tabs)` in `src/app/`, so its screens are NOT
behind the root `Stack.Protected guard={baseUrl !== null}` that every `(tabs)` feature screen sits
behind (pulse-notes #16 flagged that gate as load-bearing — the mock client is normally hit only by
tests/parallel-dev, since a cold launch lands on /connect). For the authored deep-link smoke spec
this is fine, and placement is the orchestrator's call during nav consolidation. **Orchestrator
decision needed:** either (a) move the `(more)` screens under the protected `(tabs)` subtree (e.g.
nest them so the More tab pushes onto a protected stack), or (b) wrap `(more)` in its own
`Stack.Protected`. I did NOT touch the root/tabs `_layout.tsx` to "fix" this — that's the
consolidation step. Flagging so it's a deliberate choice, not inherited by accident.

## Component tiers honored (pulse-notes #16)

- **Tier-1 shared (`src/ui/`):** CONSUMED, never modified — `Card`, `SectionHeader`, `StatTile`
  (claude card uses its own inline mini-stat to fit 3-up; could be promoted later), `StatusPill`,
  `KeyValueRow`, `MetricChart`, `MockBadge`.
- **Tier-2 feature (`src/features/<x>/components/`):** `WeatherCard`, `AccountUsageCard` /
  `AccountHistoryCharts` / `RangeSelector`, `DaemonStatusHeader` / `RunRow` / `RunLogSheet`,
  `ContainerRow` — created freely per feature, each composing Tier-1 primitives + the feature's
  local formatters.
- **No NEW shared primitive needed** → nothing to promote. (`Banner` was initially mis-used for a
  generic message; it is connection-status-specific, so the containers Docker-unavailable notice
  uses a plain `Card` + text instead — no shared edit.)

## Tests

Each feature has a `queries.test.ts` (exercises the mock client + the `queryOptions` factories'
queryFns — exactly what `useQuery` calls; no React renderer, per the foundation's deliberate choice)
and a `units.test.ts` (pure formatter/mapper behavior, incl. hand-built `MultiBucketHistoryResult`
fixtures for the claude-usage mapper — NOT round-tripped through the wrong-shaped mock). The factory
tests assert key shape, polling interval, queryFn presence, AND the mock-gap coercions
(claude history → `{series:[]}`, daemon runs/log → `[]`).

## Device-only deferrals (DEFERRED to the user — need a sim / device)

1. **victory-native XL chart render** for the claude-usage per-bucket charts — same as pulse:
   tsc-clean + API-verified, but on-device GPU render is unverifiable here. Empty/`hint` state paints
   from `[]` until history exists.
2. **NativeWind `dd-*` className rendering** — the `bg-dd-bg-base` etc. utilities resolve only at
   Metro/runtime (the chart/Skia path is immune; it uses `useThemeColors()` concrete hex).
3. **Modal sheet behavior** (`RunLogSheet`, claude range control) — native Modal present/dismiss +
   the daemon log scroll are device-verifiable only.
4. **Appium specs** (`features-rest.smoke.spec.ts`) — authored + type-check (`tsc -p e2e/tsconfig.json`),
   NOT run. To run: build the dev-client, `DD_APP_PATH=…`, `bun run e2e:appium`, then `bun run e2e`.
   They pair via the deep-linked pairing URI first (gate opens), then navigate to each `(more)` route
   — which REQUIRES the orchestrator's navigation-registration TODO above to be done first (the
   routes need a tab/menu entry to be reachable by tap). Until then the specs can only assert the
   screens once navigated programmatically.
