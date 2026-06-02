# 16 — Feature: Pulse + Mobile Data Layer (Plan 05 / D32) implementation notes

> Worktree `feat/dev-dashboard-mobile`, committed directly. All work scoped to
> `DevDashboard/mobile/`. `src/dev-dashboard/` and `DECISIONS.md` were NOT touched (read-only).
> No Metro / `expo start` / simulator / `expo run` was started — device builds + Appium runs are
> the user's job.

## Status: COMPLETE — data-layer foundation + Pulse reference screen + Appium gate built, committed, green where verifiable without a sim.

- **`bunx tsc --noEmit` (app): 0 errors.** `bunx tsc -p e2e/tsconfig.json`: 0 errors.
- **`bun test src/`: 55 pass / 0 fail across 14 files** (14 new this plan + 41 prior).
- **`expo lint`: 0 problems.**
- Use `bunx tsc` NOT `tsgo` for the mobile app (tsgo can't resolve RN's `types` export condition — see plan-04 notes 13).

## Commits (one per logical step)

| Step | Commit | Subject |
|---|---|---|
| A | `8cbe4ac14` | D32 data layer — client provider, comprehensive mock, per-feature pulse queries/hooks |
| B1 | `e420cd521` | pulse shared deps + theme-color resolver, cn helper, Card forwarding, MockBadge, units |
| B2 | `9067c270b` | compose Pulse screen — 6 KPI cards, victory-native charts, sparklines, live dot |
| C | `e40771df8` | Pulse Appium Page Object + spec (WDIO/Mocha, accessibility-id locators) |
| notes | `0b42d5a86` | this notes file |
| primitives | `2d6a1fd83` | seed Tier-1 shared UI primitives + refactor Pulse onto them |

**Foundation milestone = `8cbe4ac14` (data layer) + `2d6a1fd83` (seeded Tier-1 shared primitives).**
Together they unblock the parallel feature fan-out: shared `src/api/*` + comprehensive mock +
`src/features/pulse/{queries,hooks}` worked example + the shared `src/ui/` primitive set.

---

## ► THE DATA-LAYER PATTERN OTHER FEATURES COPY (D32) — read this to add a feature

The pattern is split into **shared infra** (stable, almost never edited) and **per-feature folders**
(each feature owns its own; parallel agents touch ZERO shared files → no merge conflicts).

### Shared infra (do NOT grow per feature) — `src/api/`
- **`client-provider.tsx`** — `<ClientProvider>` exposes the ACTIVE `@dd/contract` client via context.
  When a transport is connected it uses **`transport.client()`** (tier-correct — the managed tier
  returns an E2E-wrapped client so the relay only sees ciphertext; a hand-built
  `createDashboardClient`/`buildClient()` would BYPASS that, a security bug). When nothing is
  connected it falls back to the **mock**. `useDashboardClient()` reads the client; `useIsMockClient()`
  drives the "mock data" badge. Wired inside `<QueryClientProvider>` in `src/app/_layout.tsx`.
- **`mock-client.ts`** — `mockDashboardClient`, typed as `DashboardClient` (compiler enforces parity).
  **COMPREHENSIVE**: realistic fixtures for EVERY contract method (system / weather / tmux / ttyd /
  cmux / obsidian / qa incl. SSE `subscribe`, AND the generic `get`/`post` escape hatch which
  path-switches the deferred claude/daemon/containers/todos routes). Parallel feature agents CONSUME
  this without editing it — add fixtures for NEW endpoints here as the contract grows; never
  special-case per screen.
- **`query-keys.ts`** — the key CONVENTION + a `featureKey(root)` helper. It is read, not edited, when
  a feature is added. (D32 said a literal `src/api/queries.ts` monolith; the coordinator's per-feature
  layout supersedes it — keys live with the feature, see below. Recorded as a deliberate refinement.)

### Per-feature folder — `src/features/<feature>/`
- **`queries.ts`** — owns BOTH `<feature>Keys` (co-located key object whose tuples lead with a UNIQUE
  root segment, e.g. `["pulse", …]`) AND one TanStack-v5 `queryOptions` FACTORY per endpoint, each
  closing over the injected `DashboardClient`:
  ```ts
  export const pulseKeys = { snap: ["pulse","snap"] as const, history: (m,min)=>["pulse","history",m,min] as const };
  export function pulseQuery(client: DashboardClient) {
      return queryOptions({ queryKey: pulseKeys.snap, queryFn: () => client.system.pulse(), refetchInterval: 5000 });
  }
  ```
- **`hooks.ts`** — thin component-facing hooks, one line each:
  ```ts
  export const usePulse = () => useQuery(pulseQuery(useDashboardClient()));
  ```
  **Components import THESE — never raw `useQuery`** (hard D32 rule).
- **`units.ts`** (+`.test.ts`) — pure feature formatters (reimplemented locally; NO `@app/*` import,
  it would drag web/server code into the RN bundle).
- **`components/`** — presentational RN components. Colors via `useThemeColors()` (concrete hex) for
  Skia/inline-style; NativeWind `dd-*` classes elsewhere. Every locatable element carries a `testID`.
- The tab screen lives at `src/app/(tabs)/<feature>.tsx` and composes the components off the hooks.

### To add `src/features/terminals/` (or qa/obsidian/…):
1. `queries.ts`: `terminalsKeys` (root `"ttyd"`/`"cmux"`/…), `queryOptions` factories over `client.<domain>.*`.
2. `hooks.ts`: `useX = () => useQuery(xQuery(useDashboardClient()))`.
3. `components/` + fill the tab screen at `src/app/(tabs)/<x>.tsx` (keep the existing `screen-<x>` testID).
4. Co-locate a `queries.test.ts` testing the mock + factories (see below).
5. The mock already covers your endpoints — do NOT edit `mock-client.ts` unless the contract itself grows.

### COMPONENT TIERS (shared vs feature) — keeps the parallel fan-out conflict-free

- **Tier 1 = shared presentational primitives in `src/ui/`** (the "Obsidian Terminal" aesthetic).
  Feature agents **CONSUME** these — they must **NOT modify** them (parallel edits to a shared file =
  merge conflicts). Import from the barrel: `import { StatTile, SectionHeader, MetricChart, ListRow,
  KeyValueRow, StatusPill, Card } from "@/ui"`. Seeded this plan:
  - `MetricChart` (victory-native XL wrapper; area + sparkline; `formatX` injectable so it has no
    feature import) + `VictoryMetricChart` + `MetricPoint`/`MetricChartProps`.
  - `StatTile` (label + big value + sub; 2-up grid; `<testID>-value`).
  - `SectionHeader` (mono uppercase accent card header).
  - `ListRow` (truncated primary + trailing value/node; optional `onPress`).
  - `KeyValueRow` (left label / right value mono row).
  - `StatusPill` (rounded tinted pill, tones `accent|muted|danger`, optional dot).
  - `MockBadge` (auto-hides when a real transport is connected).
  - plus the pre-existing `Card / Screen / Loading / Empty / Banner / ErrorBoundary / TabPlaceholder`.
- **Tier 2 = feature components in `src/features/<x>/components/`** — created freely per feature.
  Pulse's `KpiCard` (thin `StatTile`), `NetworkInfo`, `ProcessTable`, `WeatherCard`, `RangeSelector`,
  `SparklineRow` are the worked examples — each composes Tier-1 primitives + the feature's formatters.
- **Need a NEW shared primitive?** Build it **feature-local** first and **FLAG it in your notes**; the
  orchestrator promotes it to `src/ui/` in a consolidation pass. **Parallel agents must NOT touch
  `src/ui/*` or `src/api/*`** mid-fan-out.

---

## Files created / modified (all under `DevDashboard/mobile/`)

**Shared infra (`src/api/`):** `client-provider.tsx`, `mock-client.ts`, `query-keys.ts`.
**Shared support:** `src/theme/colors.ts` (concrete `--dd-*` hex resolver `useThemeColors()`),
`src/lib/cn.ts` (twMerge helper), `src/types/assets.d.ts` (`*.ttf`/`*.otf` decl).
**Tier-1 shared primitives (`src/ui/`):** `MetricChart.tsx`, `StatTile.tsx`, `SectionHeader.tsx`,
`ListRow.tsx`, `KeyValueRow.tsx`, `StatusPill.tsx`, `MockBadge.tsx`, `index.ts` (barrel).
**Modified shared:** `src/ui/Card.tsx` (now forwards+merges `className` + `style` via `cn()`),
`src/app/_layout.tsx` (`<ClientProvider>` inside `<QueryClientProvider>`).
**Pulse feature (`src/features/pulse/`):** `queries.ts`, `hooks.ts`, `queries.test.ts`, `units.ts`,
`units.test.ts`, `components/{KpiCard,SparklineRow,ProcessTable,NetworkInfo,WeatherCard,RangeSelector}.tsx`
(the feature `MetricChart` was promoted to the shared `src/ui/MetricChart.tsx`).
**Pulse screen:** `src/app/(tabs)/index.tsx` (filled in; root testID stays `screen-pulse`).
**E2E:** `e2e/pages/PulsePage.page.ts`, `e2e/specs/pulse.spec.ts`.
**Deps:** `victory-native@41.20.3`, `@shopify/react-native-skia@2.4.18`, `@expo-google-fonts/inter@0.4.2`
(via `npx expo install` — SDK-55-resolved; New Arch always-on per D3).

## Tests

- `src/features/pulse/queries.test.ts` (10 tests): exercises the mock client directly (pulse range,
  ascending history within window, weather, the tmux/ttyd/cmux/obsidian/qa endpoints parallel
  features consume, `qa.subscribe` emit+close, the `get`/`post` escape-hatch path-switch) AND the
  `queryOptions` factories (key shape, polling interval, queryFn presence). **No React renderer** —
  none is installed; adding one (`@testing-library/react-native`) would be a D20 lib decision and the
  hooks are one-liners with no logic, so testing the mock + factory IS the meaningful seam (advisor-confirmed).
- `src/features/pulse/units.test.ts` (4 tests): pure formatter null/format behavior.

## Deviations from the plan-05 doc (and why)

1. **Layout: `src/`-nested, not the plan-05 doc's flat `app/`+`lib/`+`components/`.** Plan-04 actually
   scaffolded a `src/`-nested Expo project (`@/*` → `./src/*`). Plan-05's "flat layout" section was an
   assumption that didn't survive plan-04. Everything is under `src/` accordingly.
2. **Data layer = brief/D32's `src/api/` + per-feature folders, NOT plan-05's `lib/pulse/hooks.ts`
   singleton.** Plan-05 (2026-05-29) predates D32 (2026-05-30); its hooks imported a `dashboardClient`
   SINGLETON and called `dashboardClient.system.pulse()` directly — which violates D32 ("mock↔real
   swapped at the CLIENT, never at the hooks"). Discarded that; built the brief's provider + mock +
   per-feature factories instead.
3. **`client.weather()`, NOT plan-05's `client.weather.snapshot()`.** The shipped contract exposes
   `weather()` returning `WeatherRes = WeatherSnapshot`. One call site adjusted.
4. **`useThemeColors()` is a NEW dark-only resolver (`src/theme/colors.ts`), not the template's
   `useTheme()`.** The template `useTheme()` returns light/dark `Colors`; the dashboard is dark-only
   and Skia needs concrete `--dd-*` hex. Mirrors `tokens.css` 1:1; keys stable for the v5 migration.
5. **`Card` extended to forward `className` + `style`** (plan-05 assumed it already did). Done at the
   root (one fix, not per call site) via a new `cn()` helper; the base `bg-dd-bg-panel`/`border`
   surface is preserved (design-system rule — caller appends layout, can't replace the surface).
6. **Appium = WDIO/Mocha (matches the real harness), NOT plan-05's `bun:test` + `@/e2e/appium-helpers`.**
   Plan-04/02 built a WebdriverIO/Mocha harness (`BasePage`, `~accessibility-id`, singleton page
   objects). `PulsePage`/`pulse.spec.ts` mirror `ConnectPage`/`connect.spec.ts` exactly. Plan-05's
   importable-MCP-helper version was never the real harness.
7. **`@expo-google-fonts/inter@0.4.2` ships the TTF at `inter/500Medium/Inter_500Medium.ttf`**, not the
   plan's `inter/Inter_500Medium.ttf` path. Import corrected; `*.ttf` ambient decl added.
8. **`SqlitePulseHistoryStore` / `initialData` offline-seed (plan-05 Task 2) DEFERRED.** The brief
   doesn't require it, it's Pulse-specific + native (not unit-testable, not part of the copyable
   pattern), and it would couple the data-layer pattern to SQLite. Charts paint from the live query
   (or `[]` → em-dash empty state). If wanted later, add it behind the `pulseHistoryQuery` factory's
   `queryFn` (write-through) + `initialData` — without polluting the shared pattern. Noted for follow-up.

## Important behavior note for fan-out agents

The tabs are gated behind `useConnection.baseUrl !== null` (root `Stack.Protected`), and connecting
sets a REAL transport. So **in the normal app flow the mock client is exercised only by tests and by
parallel-dev** (e.g. temporarily relaxing the gate, or rendering a feature in isolation) — NOT by
"just launch and browse" (a cold launch lands on /connect). Don't expect mock data on the device
without either connecting or relaxing the gate.

## What REQUIRES a simulator / device (DEFERRED to the user)

1. **Build + launch dev-client** (`npx expo run:ios`) — first run prebuilds `ios/` with the Skia +
   victory-native native modules (New Arch). Skia/victory-native cannot run in Expo Go.
2. **victory-native XL renders on New Arch / SDK 55** — API verified against context7
   (`/formidablelabs/victory-native-xl`, 2026-05-30: `CartesianChart`/`Area`/`LinearGradient`/`useFont`
   shapes all match) and tsc-clean, but on-device GPU render is unverifiable here.
3. **NativeWind `var(--dd-*)` class rendering** — same plan-04 caveat (CSS-custom-property colors
   resolve only at Metro/runtime). The chart/Skia path is immune (it uses `useThemeColors()` concrete
   hex), but the `dd-*` classNames on the cards/text are the open item; inline-hex is the ready fallback.
4. **`Inter_500Medium.ttf` Metro asset load** for `useFont` axis labels — `require()` → numeric asset id
   is a Metro-bundle property, verifiable only on device. If it fails, `useFont` returns null and the
   chart still renders (axes just lack labels until the font resolves).
5. **Pulse Appium spec (`e2e/specs/pulse.spec.ts`)** — authored + type-checks; NOT run (no sim). To run:
   build dev-client, `DD_APP_PATH=…`, `bun run e2e:appium`, then `bun run e2e`. It pairs via a
   deep-linked pairing URI first (gate opens), then opens the Pulse tab. Needs a test Agent reachable
   at the paired baseUrl with Basic auth satisfied (an empty password 401s the probe — see plan-04/02).

## Lib decisions (D20)

No NEW lib decision needed. `victory-native` + `@shopify/react-native-skia` are D14 (locked);
`@expo-google-fonts/inter` is the plan-05-sanctioned font source for `useFont`; `clsx`/`tailwind-merge`
were already in `package.json`. A React test renderer was intentionally NOT added (would be a D20
decision) — the hook one-liners are covered transitively by the mock + factory tests.

## Coordinator ping note

No SendMessage/agent-to-coordinator tool exists in this agent's environment (searched twice). The
foundation milestone is surfaced in the final report instead for the parent to relay:
**"foundation committed at `8cbe4ac14` (data layer) + `2d6a1fd83` (Tier-1 shared UI primitives);
per-feature pattern: shared infra in `src/api/` (client-provider swaps mock↔real at
`transport.client()`, comprehensive `mock-client.ts`, `query-keys.ts` convention) + Tier-1
primitives in `src/ui/` (consume, never edit); each feature adds `src/features/<x>/{queries,hooks}.ts`
(co-located `<x>Keys` + `queryOptions` factories over the injected client + thin `use*` hooks) +
`components/` + its tab screen — touching ZERO shared files. This unblocks the parallel fan-out."**
