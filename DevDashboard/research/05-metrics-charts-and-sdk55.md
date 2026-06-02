# 05 — Live-Updating Metric Charts + Expo SDK 55 Foundation Cheat-Sheet

> Research date: **2026-05-29**. Target: **Expo SDK 55 (GA Feb 2026), React Native 0.83, React 19.2, New Architecture MANDATORY** (Legacy Arch removed; any lib that does not support Fabric/TurboModules is unusable). Distribution = EAS dev-client/prebuild (config plugins + custom native allowed). This file covers **(A) charting for the Pulse CPU/mem/swap sparklines + area charts** and **(B) the SDK-55 foundation version cheat-sheet**. Terminal/ttyd parity is a *separate* research file — not covered here.

## TL;DR

- **Charts pick: `victory-native` (XL, v41.21.1)** — Skia-canvas renderer (GPU, not an SVG view tree), actively maintained (release **2026-05-28**), declarative `<CartesianChart>`/`<Area>` API that maps 1:1 onto the existing recharts `PulseGraph` (`{ts, value}`, 0–100 domain, gradient `<Area>`). For smooth ~1Hz redraws of multiple metrics, a Skia canvas beats SVG decisively. Runner-up for *single* sparklines: **`react-native-graph`** (also Skia, updated to the RN-0.83/Reanimated-4 stack in v1.2.0). **Avoid `react-native-gifted-charts`** for live data (SVG view-tree re-render per frame + an open New-Arch iOS tooltip bug) and **`react-native-wagmi-charts`** (SVG+Redash, candlestick-focused, slow maintenance, Uniswap ships it only with a perf patch).
- **New-Arch gate barely bites for charts**: every candidate is pure-JS/TS rendering over a native dep that is already New-Arch-ready (Skia 2.x, react-native-svg 15.x, Reanimated 4 = New-Arch-*only*, gesture-handler 2.30). The real discriminators are **(1) Skia-canvas vs SVG-view-tree redraw cost at 1 Hz** and **(2) maintenance recency**.
- **SDK 55 foundation is locked & verified** from `expo@55` `bundledNativeModules.json`: Reanimated **4.2.1** (New-Arch only) + `react-native-worklets` **0.7.4**, gesture-handler **~2.30.0**, screens **~4.23.0**, safe-area-context **~5.6.2**, react-native-svg **15.15.3**, Skia **2.4.18**, expo-router **~55.0.13** (native tabs), expo-secure-store **~55.0.13**, expo-background-task **~55.0.17**, expo-notifications **~55.0.20**. **MMKV v3+ is a New-Arch TurboModule (use it)**; **theming = NativeWind v5 (preview) + react-native-css + Tailwind v4** is the SDK-55-blessed path (Expo's own tailwind skill); **Unistyles 3** is also New-Arch-only if you prefer StyleSheet ergonomics; TanStack Query v5 is fine on RN.

---

# Part A — Charting libraries for live-updating system metrics

**How to read the New-Arch column:** these are *pure-JS* libraries — they ship no codegen/TurboModule of their own; they render through a native dependency. So "New Arch: yes (inherited via X)" means *the native renderer X is New-Arch-ready and the JS lib's current release pins a New-Arch-era version of X*. That is the correct, verified reading — not "unknown."

The matchup splits on renderer:
- **Skia canvas (GPU bitmap, one draw call per frame):** victory-native XL, react-native-graph, @shopify/react-native-skia direct. → best for frequent full-series redraws.
- **SVG view tree (native `<Path>`/`<G>` nodes diffed per frame):** gifted-charts, wagmi-charts (wagmi also leans on Reanimated/Redash for the cursor). → fine for static/occasional updates, heavier at 1 Hz with many points.

---

## A1. victory-native (XL) — **RECOMMENDED**

- **Repo:** https://github.com/FormidableLabs/victory-native-xl — **~1,181 stars** (this is the XL-rewrite repo specifically; do **not** conflate with the legacy Victory monorepo's ~11k stars). npm package name is just `victory-native`.
- **Latest version:** `victory-native@41.21.1`, published **2026-05-28** (verified via `gh api .../releases/latest` and `npm view`).
- **Maintenance:** Actively maintained by **Nearform** (formerly Formidable). Repo `pushed_at` **2026-05-29**; steady 41.x releases through May 2026. Not archived. **Green.**
- **New Architecture:** **yes (inherited).** Renders on **`@shopify/react-native-skia`** (New-Arch-ready, SDK 55 bundles Skia 2.4.18) and uses **Reanimated** shared values for gestures/press state. Verified `peerDependencies`: `@shopify/react-native-skia >=1.2.3 <3.0.0`, `react-native-reanimated >=3.0.0`, `react-native-gesture-handler >=2.0.0`. All satisfied by the SDK-55 pins (Skia 2.4.18, Reanimated 4.2.1, GH 2.30). Reanimated 4 is **New-Arch only**, which transitively guarantees New-Arch.
- **Expo compatibility:** **dev-client/prebuild** (NOT Expo Go) because Skia is custom native code. No dedicated config plugin needed beyond installing Skia/Reanimated/GH (each is an Expo-config-aware native module; `npx expo install` wires them). Works fully under SDK 55 prebuild.
- **Live-update performance:** **Best in class for our case.** Skia is a GPU canvas — a full-series redraw is one paint, not a per-node native diff. Nearform markets "animate at over 100 FPS even on low-end devices." At ~1 Hz pushing a rolling window of CPU/mem/swap points, this is comfortably within budget; the cost is dominated by Skia's single canvas paint, not by React reconciliation of an SVG tree.
- **Real working example (verified, not a blog):** independent adopters of XL (v41) found via gh_grep on `package.json` — **`expo/examples/with-victory-native`** (Expo's own official example template), **`polarsource/polar`** (Polar's production mobile app, Apache-2.0, `victory-native@^41.20.2`), **`CodeWithCJ/SparkyFitness`** (`^41.20.2`), and **`ruvnet/RuView`** (`^41.20.2`). Plus the library's own Expo example app (`example/app/custom-drawing.tsx`, imports `CartesianChart` + Skia). This is the strongest independent-adoption evidence of the five candidates.
- **API fit to existing `PulseGraph`:** Direct. The web `PulseGraph` uses recharts `<AreaChart>` with `<Area type="monotone">`, a 0–100 `<YAxis domain>`, and a gradient fill. victory-native XL maps this to `<CartesianChart data={...} xKey="ts" yKeys={["value"]} domain={{ y: [0,100] }}>{({ points }) => <Area points={points.value} y0={...} animate={{ type: "timing" }} />}</CartesianChart>` with a Skia `<LinearGradient>` for the fill. Same mental model, swappable behind the planned terminal/chart interface.
- **Risk verdict:** **LOW** — actively maintained, GPU renderer purpose-built for animated charts, declarative API close to the existing recharts code, real Expo example in-repo.

---

## A2. react-native-graph (Margelo / mrousavy) — **strong runner-up for single sparklines**

- **Repo:** https://github.com/margelo/react-native-graph — **~2,498 stars**.
- **Latest version:** `react-native-graph@1.2.0`, published **2026-04-15/16** (verified `gh api releases/latest` → `v1.2.0`).
- **Maintenance:** Repo `pushed_at` **2026-04-16** — ~6 weeks stale relative to the others, but **NOT abandoned**. v1.2.0 is a *deliberate* modernization: the package.json dev-deps are pinned to **`react-native@0.83.2`, `react@19.2.0`, `@shopify/react-native-skia@^2.5.3`, `react-native-reanimated@^4.2.3`, `react-native-worklets@^0.7.4`, `@react-native/babel-preset@0.83.0`** — i.e. it was explicitly updated to the exact Expo-SDK-55 stack. (This refutes the common "it's pinned to an old Skia / stale" assumption — verified from the master `package.json`.) Lower release cadence is the only knock. **Yellow-green.**
- **New Architecture:** **yes (inherited).** Skia-based line graph; `peerDependencies` are `react-native-reanimated *` + **`react-native-worklets *`** (the package split out of Reanimated 4) — depending on `react-native-worklets` at all is direct evidence it targets the Reanimated-4 / New-Arch era. README: "based on the high performance 2D graphics rendering engine Skia… up to 120 FPS."
- **Expo compatibility:** **dev-client/prebuild.** Install Reanimated + gesture-handler + Skia + react-native-graph (README's exact install order). No Expo Go (Skia native).
- **Live-update performance:** **Excellent for line/sparkline.** Native Skia path interpolation + "native path interpolation in Skia" for animating between data changes; `animated={false}` mode is the "lightweight renderer optimal for displaying a lot of graphs in large lists." Designed for crypto wallets re-rendering thousands of token graphs (Pink Panda Wallet). For a *single* CPU sparkline updating at 1 Hz, this is ideal.
- **Limitation for our case:** It is a **LineGraph only** — no built-in axes/grid/area-fill/tooltip system like victory-native. The Pulse area charts (gradient fill + Y-axis 0–100 + tooltip) would need hand-rolling. Great for the compact sparkline row, weaker for the full area-chart panels.
- **Real working example (verified):** **Papillon** (popular FR school app, GPL-3.0) — `app/(tabs)/grades/atoms/Averages.tsx` imports `import { LineGraph } from "react-native-graph"` next to `expo-router` + `react-native-reanimated` (https://github.com/PapillonApp/Papillon). Also `rbatsenko/hangs-free` (Expo Router app) uses it in `app/(tabs)/lift.tsx`. Plus the production **Pink Panda Wallet** (README sponsor).
- **Risk verdict:** **LOW–MEDIUM** — perfect renderer and on the exact SDK-55 stack, but single-purpose (no axes/area system) and slower release cadence; best as the *sparkline* renderer, with victory-native handling the area panels.

---

## A3. @shopify/react-native-skia (direct) — escape hatch, not the first choice

- **Repo:** https://github.com/Shopify/react-native-skia — **~8,382 stars**.
- **Latest version:** `@shopify/react-native-skia@2.6.4` (npm, **2026-05-26**); **SDK 55 bundles 2.4.18**.
- **Maintenance:** Very active (`pushed_at` **2026-05-27**), first-party Shopify, the foundation both A1 and A2 build on. **Green.**
- **New Architecture:** **yes (first-class).** Skia is a New-Arch-ready Fabric component; it is *the* canonical New-Arch graphics renderer. SDK 55 ships it in bundledNativeModules.
- **Expo compatibility:** **dev-client/prebuild** (`npx expo install @shopify/react-native-skia`). Not Expo Go.
- **Live-update performance:** **Maximum** — you draw the path yourself each frame; nothing faster. But you also implement axes, scaling, gradients, gesture scrubbing, and the rolling-window buffer by hand.
- **Real working example (verified):** it's the renderer inside victory-native XL's `example/custom-drawing.tsx` (imports both). William Candillon's "Can it be done in React Native" series is the canonical body of hand-drawn Skia charts.
- **Risk verdict:** **MEDIUM** — zero library risk, but high *implementation* risk/effort. Keep as the swappable-interface fallback if victory-native ever blocks you; don't start here.

---

## A4. react-native-gifted-charts — **NOT recommended for live data**

- **Repo:** https://github.com/Abhinandan-Kushwaha/react-native-gifted-charts — **~1,331 stars**.
- **Latest version:** `react-native-gifted-charts@1.4.77`, published **2026-05-19/20** (verified). Core logic in `gifted-charts-core@0.1.81`.
- **Maintenance:** Active, single-maintainer, frequent patch releases (`pushed_at` **2026-05-20**). **Green on maintenance.**
- **New Architecture:** **yes (inherited, with a caveat).** Renders via **`react-native-svg`** (New-Arch-ready since v15; SDK 55 bundles 15.15.3) + `expo-linear-gradient`/`react-native-linear-gradient`. **BUT** New-Arch *interactive* features had rough edges on earlier New-Arch RN releases: issue **#995** "customDataPoint property breaks the app" reproduced on **RN 0.76 New Architecture** (Feb 2025), and an issue reporting "pointerConfig tooltip not working on iOS with RN 0.77 (New Architecture)." Current status on RN 0.83 is unverified, but the pattern (tooltip/interactive on New Arch) is exactly the path we'd lean on for hover-value.
- **Expo compatibility:** Works in **Expo Go and dev-client** (SVG + expo-linear-gradient are Expo-Go-safe) — the only candidate that *could* run in Expo Go. Irrelevant for us (we're dev-client anyway), but lowest setup friction.
- **Live-update performance:** **Weakest fit.** It renders an **SVG view tree** — every metric tick re-diffs native `<Path>`/`<G>` nodes through React reconciliation. Fine for static dashboards / occasional updates; at sustained 1 Hz with a rolling window across CPU+mem+swap it does more work per frame than a Skia canvas, and the open New-Arch tooltip bugs hit the interactive path you'd want for hover-value.
- **Real working example (verified):** widely used; npm "most loved" Bar/Line/Area lib; demo site https://gifted-charts.web.app/. Many production Expo apps, but primarily for *static/snapshot* dashboards, not 1 Hz streams.
- **Risk verdict:** **MEDIUM–HIGH for live use** (low for static). SVG re-render cost + open New-Arch interactive bugs make it the wrong tool for streaming sparklines. Excellent if you ever need quick *static* Pie/Donut/Bar panels.

---

## A5. react-native-wagmi-charts — **NOT recommended**

- **Repo:** https://github.com/coinjar/react-native-wagmi-charts — **~706 stars**.
- **Latest version:** `react-native-wagmi-charts@2.10.0`, published **2026-04-28** (verified). Most recent commits are the v2.10.0 release batch (2026-04-28).
- **Maintenance:** Maintained but **slow/bursty** (CoinJar-sponsored). The repo went long stretches between releases historically; v2.10.0 in Apr 2026 is the latest. **Yellow.**
- **New Architecture:** **yes (inherited).** `peerDependencies`: `react-native-svg *`, `react-native-reanimated *`, `react-native-gesture-handler *`, **`react-native-redash *`**. It renders via **SVG** and animates the cursor via Reanimated/Redash. Redash is a thin Reanimated helper (rides Reanimated 4 = New-Arch), and react-native-svg 15 is New-Arch-ready — so it *runs* on New Arch. No wagmi-specific New-Arch *blocker* found. **Caveat (perf, primary source):** Uniswap's mobile monorepo pins an **old** `react-native-wagmi-charts@2.5.2` with a **patch** and the comment *"this fixes really bad performance issue when the pulse dot is enabled"* — a perf workaround on 2.5.x (two minors behind the current 2.10.0; may already be fixed upstream). (Note: the separate "should be removed after migrating to the new architecture" comment in that same Uniswap file is about `react-native-sortables`, **not** wagmi — do not attribute it here.)
- **Expo compatibility:** **dev-client/prebuild**; the in-repo `example/` is an Expo app (`npx expo start`).
- **Live-update performance:** Built for **candlestick/line crypto charts with a scrubbing cursor**, not streaming system metrics. SVG-based, and the known "pulse dot" perf issue is a direct red flag for an animated live indicator. Older issue #38: line chart drops frames above ~55 data points on iOS.
- **Real working example (verified):** **Uniswap mobile wallet** (`apps/mobile/package.json` pins `react-native-wagmi-charts@2.5.2`) — a genuinely shipped app, but they ship it *patched*. Also `notJust-dev/CryptoTracker`.
- **Risk verdict:** **MEDIUM–HIGH** — finance-candlestick-shaped API (mismatch for CPU/mem area charts), SVG renderer, documented perf patch needed by its biggest production user, slow maintenance. Wrong tool here.

---

## A — Recommendation

**Adopt `victory-native` (XL, v41.x) as the primary charting library**, behind the planned swappable `MetricChart` interface. It is the only candidate that combines: (1) a **Skia GPU canvas** (right renderer for 1 Hz full-series redraws), (2) a **declarative axes + area + gradient + tooltip API** that ports the existing recharts `PulseGraph` almost line-for-line, (3) **active maintenance** (release 2026-05-28), and (4) a **real in-repo Expo example**. Its native deps (Skia 2.4.18, Reanimated 4.2.1, gesture-handler 2.30) are all SDK-55-bundled and New-Arch-mandated.

- **Sparkline-only rows:** consider `react-native-graph` as the renderer — it's on the exact SDK-55 stack and is purpose-built for compact animated line graphs (the lightweight `animated={false}` mode is ideal for a grid of many sparklines). Keep both behind the same interface so you can A/B them.
- **Fallback / escape hatch:** `@shopify/react-native-skia` directly, only if a chart need outgrows victory-native.
- **Reject for live metrics:** `react-native-gifted-charts` (SVG re-render + open New-Arch tooltip bugs; keep in pocket for *static* Pie/Bar) and `react-native-wagmi-charts` (candlestick-shaped, SVG, documented perf patch in production).

Interface sketch (keeps the approach swappable per the design constraint):
```ts
interface MetricChartProps { title: string; points: { ts: number; value: number }[]; unit?: string; domain?: [number, number]; }
// VictoryMetricChart, GraphMetricChart, SkiaMetricChart all implement MetricChartProps
```

---

# Part B — Expo SDK 55 foundation cheat-sheet (verified versions)

**Authoritative source:** the bundled-version pins below come from `expo@55`'s `bundledNativeModules.json` (fetched live, 2026-05-29) — the file `npx expo install` consults to resolve compatible versions. **Use `npx expo install <pkg>` (not `npm/bun add`) for any native module** so it resolves the SDK-55-pinned version automatically. (`npm view <pkg> version` shows the *latest* tag, which for many Expo packages is already the SDK-56 dev line — e.g. `expo-router` latest is `56.2.8`; the SDK-55 line is the `sdk-55` dist-tag / the `~55.x` bundled pin.)

## B0. Hard constraint recap — New Architecture is mandatory

Per Expo docs (https://docs.expo.dev/guides/new-architecture): "Starting with React Native 0.82, the New Architecture is always enabled and cannot be disabled. SDK 55 uses React Native 0.83." There is no `newArchEnabled` flag to toggle. Every native dep below is New-Arch-ready; **Reanimated 4 and Unistyles 3 are New-Arch-*only*** (they literally won't build on legacy — a non-issue here, a guarantee in our favor).

## B1. Core animation / gesture / navigation primitives (SDK-55 bundled pins)

| Package | SDK-55 pin (`bundledNativeModules`) | npm latest (for reference) | Notes |
|---|---|---|---|
| `react-native-reanimated` | **4.2.1** | 4.4.0 | **New-Arch only.** v4 split worklets into a separate pkg ↓ |
| `react-native-worklets` | **0.7.4** | — | New companion pkg to Reanimated 4; **must install alongside** (it's a peer of react-native-graph too) |
| `react-native-gesture-handler` | **~2.30.0** | 3.0.0 | SDK 55 stays on **2.30** (not the new v3 latest) — use `expo install` |
| `react-native-screens` | **~4.23.0** | 4.25.2 | Backs expo-router native stack/tabs |
| `react-native-safe-area-context` | **~5.6.2** | 5.8.0 | `SafeAreaProvider` / `useSafeAreaInsets` |
| `react-native-svg` | **15.15.3** | 15.15.5 | New-Arch ready since v15; used by gifted/wagmi |
| `@shopify/react-native-skia` | **2.4.18** | 2.6.4 | GPU canvas; backs victory-native + react-native-graph |

> Install the trio together for animations: `npx expo install react-native-reanimated react-native-worklets react-native-gesture-handler`. Reanimated 4's Babel plugin is still required in `babel.config.js` (`react-native-worklets/plugin` in v4).

## B2. Routing — expo-router v7 + native tabs

- **`expo-router` SDK-55 pin: `~55.0.13`** (dist-tag `sdk-55` = `55.0.16`; npm `latest` is the SDK-56 line `56.2.8` — don't grab that). Expo-router now uses **SDK-aligned versioning** (the `55.x` line is the SDK 55 release; "Router v7" appears in launch posts/snippets but is *claimed*, not version-confirmed — go by the `55.x` pin). SDK 55 ships **native bottom tabs** (iOS 26 "liquid glass" tabs) via `expo-router/native-tabs`.
- File-based routing under `app/`. Native tabs use `<NativeTabs>` and expose `unstable_nativeProps` to pass through to `react-native-screens` `TabsScreenProps` (verified in v55 docs `/sdk/router/native-tabs`).
- For the dev-dashboard mobile app: file-based nav with a native tab bar (e.g. Pulse / Terminal / Sessions tabs). Use the local **`expo:building-native-ui`** skill for the canonical native-tabs patterns.

## B3. Auth token storage — expo-secure-store

- **`expo-secure-store` SDK-55 pin: `~55.0.13`.** Keychain (iOS) / Keystore (Android) backed. API: `setItemAsync(key, value)`, `getItemAsync(key)`, `deleteItemAsync(key)`. Use for the dashboard auth token / session secret. `npx expo install expo-secure-store`.
- Pair with TanStack Query: store the token in SecureStore, hydrate it into an in-memory auth context, attach as a bearer header in the query client's fetcher.

## B4. Server state — TanStack Query v5 on RN

- **`@tanstack/react-query@5.x`** (latest 5.100.x, 2026-05). Plain JS — no native module, no New-Arch concern. Works as-is on RN/Expo.
- RN-specific wiring (from Expo's own **`expo:native-data-fetching`** skill — authoritative): add **`onlineManager`** + **`focusManager`** integrations using `@react-native-community/netinfo` (refetch on reconnect) and `AppState` (refetch on foreground); these don't exist on native by default. Use `useQuery` with `refetchInterval` for the ~1 Hz metric polling, OR pair with a WebSocket/SSE push and `queryClient.setQueryData` for live Pulse data. Persisted cache via `@tanstack/query-async-storage-persister` over MMKV/SecureStore if offline-resume matters.

## B5. Local key-value storage — react-native-mmkv (New-Arch TurboModule)

- **`react-native-mmkv`: use v3+ (npm latest `4.3.1`; v3 line `3.3.3`).** **This is the SDK-55 answer.** Per the official RN New-Arch blog: "thanks to the New Architecture, react-native-mmkv is now a pure C++ Native Module" — i.e. **v3+ is a New-Arch-only TurboModule** (the v2→v3 jump was exactly the New-Arch rewrite). On the SDK-55 (always-New-Arch) stack, MMKV "just works"; no `newArchEnabled` flag to fight. `npx expo install react-native-mmkv` then dev-client/prebuild (it's custom native — not Expo Go).
- Use MMKV for fast synchronous prefs/cache (theme choice, last-selected session, TanStack persisted cache). Keep **secrets in SecureStore**, not MMKV (MMKV is not encrypted-at-rest by default).

## B6. Theming — NativeWind v5 + react-native-css (SDK-55-blessed) vs Unistyles 3

Three viable, all New-Arch-fine. Verified readiness:

- **NativeWind v5 + react-native-css + Tailwind v4 — RECOMMENDED, this is Expo's own documented SDK-55 path** (the `expo:expo-tailwind-setup` skill prescribes exactly: `npx expo install tailwindcss@^4 nativewind@5.0.0-preview.x react-native-css@<nightly> @tailwindcss/postcss tailwind-merge clsx`). **Caveat: NativeWind v5 is still `5.0.0-preview.4` (preview, not GA);** dist-tags = `{ latest: 4.2.4, preview: 5.0.0-preview.4 }`. v5 is **CSS-first** (no `babel.config.js` for Tailwind, no `tailwind.config.js` — use `@theme` in `global.css`), uses `@tailwindcss/postcss`, and requires wrapping components with `useCssElement` (or the provided `src/tw/` wrappers). Supports `platformColor()` for iOS system colors and `light-dark()` for dark mode — ideal for matching the dev-dashboard's `--dd-*` token theme. If you want a GA-stable choice today, **NativeWind v4.2.4** is production-ready on SDK 55 (Tailwind v3 config style).
- **Unistyles 3 (`react-native-unistyles@3.2.5`) — strong alternative.** **New-Arch-only** (v3 is a Fabric/C++ rewrite using ShadowTree updates) — perfect alignment with SDK 55. StyleSheet-API ergonomics (not utility classes), excellent theming/variants/breakpoints, very fast (updates styles natively without React re-render). Pick this if the team prefers typed StyleSheet objects over Tailwind class strings.
- **`react-native-css` (`3.0.7`)** is the runtime engine NativeWind v5 builds on; not used standalone for app theming here.

> Recommendation for *this* app: since the web dev-dashboard already uses Tailwind-flavored utility classes + CSS custom-property tokens (`--dd-bg-panel`, `--dd-border`, `--dd-text-muted`), **NativeWind (v5 if you accept preview, else v4.2.4)** gives the closest mental-model carryover and lets you reuse the token names via `@theme`/CSS vars.

## B7. Background work + notifications

- **`expo-background-task` SDK-55 pin: `~55.0.17`.** This is the **current** background-execution API — it **replaced the deprecated `expo-background-fetch`** (deprecation began SDK 53; on SDK 55 use `expo-background-task`). Built on `WorkManager` (Android) / `BGTaskScheduler` (iOS). For periodic "refresh metrics in background" use `BackgroundTask.registerTaskAsync` + `TaskManager`. Note iOS background scheduling is best-effort (OS decides timing) — not a substitute for a foreground 1 Hz poll/WS while the app is open.
- **`expo-notifications` SDK-55 pin: `~55.0.20`.** Local + push notifications (e.g. "build finished" / "session needs input" alerts from the dev-dashboard). Push requires dev-client + EAS credentials; local notifications work in dev-client directly.

## B8. Quick install recipe (SDK-55, dev-client/prebuild)

```bash
# Foundation (versions auto-resolved to SDK-55 pins by expo install)
npx expo install expo-router expo-secure-store expo-background-task expo-notifications
npx expo install react-native-reanimated react-native-worklets react-native-gesture-handler \
  react-native-screens react-native-safe-area-context react-native-svg
npx expo install @shopify/react-native-skia react-native-mmkv

# Charts (primary + sparkline runner-up)
npx expo install victory-native            # pulls compatible skia/reanimated/gesture-handler
bun add react-native-graph                 # optional sparkline renderer (peer: worklets+reanimated)

# Server state (pure JS — bun add is fine)
bun add @tanstack/react-query

# Theming — pick ONE
# (a) NativeWind v5 path (Expo-documented). NOTE: nativewind-preview + react-native-css are
#     version-COUPLED — the Expo skill pins a specific react-native-css nightly to match the
#     preview (e.g. react-native-css@0.0.0-nightly.<hash>). Use the pair the current skill prescribes;
#     don't mix a floating react-native-css with a pinned nativewind preview.
npx expo install tailwindcss@^4 nativewind@5.0.0-preview.4 react-native-css@<matching-nightly> @tailwindcss/postcss tailwind-merge clsx
# Add to package.json: "resolutions": { "lightningcss": "1.30.1" }
# (b) or Unistyles:
npx expo install react-native-unistyles
```

---

## Sources (verified vs claimed)

- **Verified via `gh api` (repos/releases) on 2026-05-29:** all five chart repos' stars, `archived:false`, `pushed_at`, and `releases/latest` tags+dates; software-mansion / Shopify / mrousavy native-dep repos.
- **Verified via `npm view` on 2026-05-29:** every package version, dist-tags, and `peerDependencies` quoted above.
- **Verified via primary source files (gh_grep):** react-native-graph `master/package.json` (RN 0.83.2 / React 19.2 / Skia ^2.5.3 / Reanimated ^4.2.3 / worklets ^0.7.4 dev-deps) and `README.md`; wagmi `master/package.json`; victory-native-xl `example/app/custom-drawing.tsx` + independent adopters (`expo/examples`, `polarsource/polar`, `CodeWithCJ/SparkyFitness`, `ruvnet/RuView`); Uniswap `apps/mobile/package.json` + `patchedDependenciesComments` (the perf patch is on wagmi 2.5.x; the "new architecture" comment there belongs to react-native-sortables, not wagmi).
- **Verified via `expo@55` `bundledNativeModules.json` (live fetch):** all SDK-55 native-module pins in §B1–B7.
- **Verified via Expo SDK 55 docs (`/websites/expo_dev_versions_v55_0_0`, context7):** native-tabs `unstable_nativeProps`; New-Arch-always-on guide; and Expo's own `expo:expo-tailwind-setup` / `expo:native-data-fetching` skills (authoritative, local).
- **Claimed (not independently load-tested here):** specific FPS numbers (Nearform "100+ FPS", react-native-graph "120 FPS") are vendor claims; gifted-charts/wagmi New-Arch *interactive* bugs are sourced from open GitHub issues (#995 etc.) and the Uniswap patch comment, not reproduced locally. The 1 Hz redraw recommendation is reasoned from renderer architecture (Skia canvas vs SVG view-tree), not a head-to-head benchmark.
