# 13 — Mobile Foundation (Plan 04) implementation notes

> Worktree `feat/dev-dashboard-mobile`. All work scoped to `DevDashboard/mobile/`. No dev
> servers, no Metro, no simulator were run (per the live-machine safety constraints). On-device /
> simulator verification is deferred to the user.

## Status: COMPLETE — all 9 plan tasks committed, green where verifiable without a sim.

## Commits (one per task)

| Task | Commit | Subject |
|---|---|---|
| 1 | `f72a2e127` | scaffold Expo SDK 55 app (New Arch, router, query, zustand) |
| 2 | `855b1a889` | wire `@devdashboard/contract` via tsconfig+metro aliases (RN-safe SafeJSON shim) |
| 3 | `47f7feb49` | storage layer — secure-store secrets, sqlite kv prefs, sqlite cache |
| 4 | `24251bc3c` | connection store + RN contract client + expo/fetch SSE |
| 5 | `d8aa3cdb6` | TanStack Query client with netinfo + AppState integration |
| 6 | `412464180` | NativeWind v4.2.4 theming + ported `--dd-*` tokens |
| 7 | `1bb6f5b66` | expo-router native tabs + placeholder screens |
| 8 | `4fd2db709` | app shell — providers, connection gate, primitives, error boundary |
| 9 | `829ed7a81` | Appium E2E harness + Page Object base + smoke spec |
| (mid) | `93bdbefb5` | refactor: adopt `@/` + `@dd/` path aliases, no relative imports (D30) |

## What was VERIFIED (no sim, no dev server)

- **`npx expo-doctor` → 19/19 checks pass, no issues.** (An initial 18/19 "custom metro.config that
  doesn't extend expo/metro-config" was a false positive when no metro.config existed yet; resolved
  once the real `expo/metro-config`-extending config was written.)
- **Contract wiring proven** by `bun test` of `contract-import.test.ts` (`paths.pulse()` resolves) AND
  a throwaway probe that constructed `createDashboardClient()` and ran `system.pulse()` through the
  full alias chain + SafeJSON shim. This proves the **alias chain + shim resolve and run under bun's
  tsconfig-path resolver** — i.e. the contract imports cleanly into the app workspace and the shim
  satisfies its `SafeJSON` calls. It does NOT prove the Metro *bundle* (the `metro.config.js` is
  verified to *evaluate*, not to resolve modules); the actual bundle resolution — and therefore the
  guarantee that `comment-json`/`esprima` are excluded at bundle time — is an **on-device check**
  (deferred item below). The logic is sound (the shim is the only thing aliased in place of
  `@app/utils/json`), but "comment-json is not bundled" is a runtime-bundle property, verifiable only
  once Metro runs.
- **Shared contract not broken** (ADR M0): `bun test src/dev-dashboard/contract/{client,contract-purity}.test.ts`
  → 5 pass / 0 fail. The new `src/dev-dashboard/contract/package.json` (`exports` map + `type:module`)
  does NOT block the web UI / Agent subpath imports (`@app/dev-dashboard/contract/client|dto|endpoints`)
  — they resolve via the repo `@app/*` alias (direct path mapping), bypassing the `exports` gate.
- **Unit tests: 10 pass / 0 fail across 3 files** — `contract-import.test.ts`, `sse.test.ts` (5
  `parseSseFrame` cases), `storage/__tests__/kv.test.ts` (4 prefs round-trip cases via a mocked
  `expo-sqlite/kv-store`).
- **Static type-check via real `tsc` (`bunx tsc --noEmit`): 0 errors in all authored files**
  (`src/{app,ui,lib,state,theme,shims}`). The E2E harness type-checks clean against its own
  `e2e/tsconfig.json` (0 errors).
- **`metro.config.js` evaluates** as a Node module: the alias `resolveRequest` is preserved, NativeWind's
  babel transformer is applied, and `watchFolders` points at the repo root.

### tsc vs tsgo note (important for future check scripts)
The pinned `tsgo` (TypeScript-Go dev build 7.0.0-dev) **cannot resolve `react-native`'s types** — RN
exposes types via the `"types"` export condition and tsgo (this build) doesn't apply it under
`moduleResolution: bundler` + `customConditions: ["react-native"]`. The **real `tsc` resolves it
fine**. So: type-check the mobile app with `bunx tsc --noEmit` (NOT tsgo). The repo pre-commit hook
runs `tsgo` but only over the root tsconfig (`include: ["src/**/*"]`), which does NOT include
`DevDashboard/mobile/` — so the pre-commit tsgo never type-checked the mobile app at all. `bunx tsc`
in the mobile dir is the authoritative mobile type gate.

### Two pre-existing, non-mine tsc errors (left as-is)
1. `src/components/animated-icon.web.tsx` — template file importing a `.css` module (web-only path; no
   `.d.ts`). Harmless on native; it's template boilerplate.
2. `../../src/utils/claude/auth.ts:281` (`'data' is of type 'unknown'`) — a **repo** file reachable
   only because `@app/*` widens the TS program to `../../src`. Not introduced by this work; not in the
   mobile app's actual import graph at runtime (only the pure contract modules are).

## Contract-wiring outcome (the `@app/utils/json` question)

**`comment-json` was NOT bundled. A shim was used instead** — the sanctioned "swap behind the alias"
path. Findings:
- The contract's only runtime value-import is `SafeJSON` from `@app/utils/json`. Every call it makes
  is `SafeJSON.parse(text, { strict: true })` (→ native `JSON.parse` in the real impl) plus one
  plain-object `SafeJSON.stringify(body)` — all behavior-identical to native JSON.
- The real `@app/utils/json` is backed by `comment-json@4.6.2`, which depends on `esprima` (a full JS
  parser) — unnecessary weight in an RN bundle, and not even installed in the worktree (a root
  `bun install` is forbidden).
- So `@app/utils/json` is aliased (tsconfig + metro) to `DevDashboard/mobile/src/shims/safe-json.ts`,
  a tiny native-JSON-backed `SafeJSON` that matches the call surface the contract uses. No
  `biome-ignore` needed on its `JSON.*` lines because the mobile tree is excluded from the root biome
  (see Deviations). This does NOT break biome's no-JSON rule for the rest of the repo — only the
  mobile shim, which biome doesn't lint, uses native JSON.

## DEVIATIONS from the plan (and why)

1. **SDK pin: scaffold defaulted to SDK 56, retargeted to SDK 55 per D3.** `create-expo-app@latest
   --template default` now pulls SDK **56** (GA since the ADR was written: expo ~56, RN 0.85, React
   19.2.3). Per locked decision **D3 = Expo SDK 55**, re-scaffolded with
   `--template expo-template-default@sdk-55` (→ expo ~55.0.26, RN 0.83.6, React 19.2.0, reanimated
   4.2.1, worklets 0.7.4, safe-area 5.6.2, screens 4.23.0 — exactly the ADR §6 pins). The SDK-56
   scaffold was moved (not deleted) to `/tmp/dd-mobile-sdk56-deleted-1780084514/mobile`.
   **DECISION FOR THE USER:** SDK 56 is GA. Retargeting to 56 later requires re-validating the §6
   native pins, the react-native-webview `patch-package` #3880 (research file 06, "verified on Expo
   55", unverified on RN 0.85), and the NativeWind readiness call (file 09). Faithful-to-D3 = 55 now;
   bumping to 56 is a deliberate follow-up, not a free upgrade.

2. **Contract NOT exposed as a bun workspace (plan Task 2 Step 2).** Per the task's explicit override,
   I did NOT add a root `package.json` `workspaces` entry and did NOT run a worktree-root `bun
   install` (vnode-exhaustion risk on the live machine). Instead the contract resolves via tsconfig
   `paths` + a Metro `resolver.resolveRequest`. I did still create
   `src/dev-dashboard/contract/package.json` (harmless name anchor matching plan Step 1).

3. **NativeWind v4.2.4 (GA), not v5** — per the deviation + D15 + research 09 (`start-v4-migrate-later`).
   Token NAMES kept identical (`bg-dd-bg-panel`, etc.) so the future v5 (CSS-first `@theme`) migration
   is config-only. Used the v4 path (Tailwind v3 `tailwind.config.js`, `@tailwind` directives in
   `global.css`, `babel-preset-expo` + `nativewind/babel` preset, `withNativeWind(config, { input })`
   in metro). The `expo:expo-tailwind-setup` skill documents the **v5** path; I deliberately did NOT
   follow it.

4. **Alias names: D30 (mid-session user directive) overrode the plan's `@app-mobile/*` /
   `@devdashboard/contract`.** Now `@/*` (mobile-internal) and `@dd/contract` (shared). No relative
   imports anywhere in app code. Wired in BOTH tsconfig `paths` AND the Metro `resolver.resolveRequest`
   (a tsconfig-only alias type-checks but fails the Metro bundle). Used Metro's `resolveRequest` rather
   than `babel-plugin-module-resolver` (Expo-recommended, no extra dep; Expo's built-in tsconfigPaths
   also reads the same aliases). The only relative strings left are inside the alias *definitions*
   themselves (`../../src/*` in tsconfig/metro) — unavoidable, you can't alias the alias source. D30
   appended to `DECISIONS.md`.

5. **Native tabs API.** The plan showed `NativeTabs.Screen` from `expo-router/native-tabs`; the actual
   SDK-55 API (confirmed via the SDK-55 template + `expo:building-native-ui`) is
   `expo-router/unstable-native-tabs` with `<NativeTabs.Trigger name><NativeTabs.Trigger.Icon sf=…
   md=…/><NativeTabs.Trigger.Label>…</…></NativeTabs.Trigger>`. Used SF Symbols (iOS) + Material
   Symbols (Android) per the docs.

6. **Mobile tree excluded from the root biome** (`!DevDashboard/mobile` in `biome.json files.includes`,
   mirroring the existing `!src/claude-history-dashboard` precedent). The Expo template ships
   2-space/single-quote code that the repo's strict biome reformats and fails on; the mobile project's
   own linter is `expo lint` (Expo-first, D20). Reversible if you'd rather run biome on RN code. The
   mobile app is also outside the root tsconfig `include`, so the toolchain boundary is now consistent.

## What REQUIRES a simulator / device (DEFERRED to the user)

These could not be checked here (no Metro, no sim, no dev server) and are the user's next steps:

1. **Build + launch the dev-client:** `cd DevDashboard/mobile && npx expo run:ios` (prebuild +
   dev-client; New Arch always-on). First run generates `ios/` (gitignored).
2. **NativeWind `var(--dd-*)` color rendering.** The `dd-*` Tailwind colors map to CSS custom
   properties (`var(--dd-bg-panel)` etc.) defined in `src/theme/tokens.css`. CSS-custom-property colors
   in NativeWind v4 only resolve at Metro/runtime — UNVERIFIABLE statically. **If they don't render
   on-device, the ready fix is to inline the hex values directly in `tailwind.config.js`** (the palette
   is dark-only, so nothing is lost, and the `dd-*` names stay identical → v5 migration still
   config-only). Token hex values are in `src/theme/tokens.css` / the web `slate-grid.css`.
3. **Native tabs render + switch** (Pulse/Terminal/Sessions/QA/More with SF Symbol icons).
4. **The connection gate.** Root `_layout.tsx` uses `<Stack.Protected guard={baseUrl !== null}>` —
   confirmed `Stack.Protected` EXISTS in the installed `expo-router` (`StackClient.js`). When `baseUrl`
   is null the only non-protected route is `/connect`, which becomes the landing. Verify the redirect
   behavior on-device.
4b. **Cold-launch rehydration is NOT wired (intentional — plan 02 scope).** The connection store is
   in-memory; `loadBasicCreds`/`loadBasicAuthHeader` exist but are never called at startup, so
   SecureStore creds are effectively write-only and every cold launch returns to `/connect` even with
   stored creds. Single-session connect→pulse works (DoD); persistent reconnect is plan 02.
5. **End-to-end debug connect:** start the Agent (`tools dev-dashboard agent --port 3043` from the MAIN
   repo — NOT the worktree), enter `http://<mac-lan-ip>:3043` + Basic creds on the device, confirm the
   probe of `/api/system/pulse` succeeds and the tabs show the live connection status. (The Pulse
   screen renders raw status now; live pulse JSON rendering is plan 05.)
6. **Appium smoke spec (`bun run e2e`).** The harness FILES are written + type-check, but were NOT run
   (no sim). To run: build the dev-client, set `DD_APP_PATH` to the built `.app`, start Appium
   (`bun run e2e:appium`), then `bun run e2e`. NOTE: the smoke spec assumes the app boots into the tabs;
   because the (tabs) group is gated by a connected baseUrl, the spec needs either a debug-seeded
   baseUrl or the connect flow run first (ConnectPage arrives in plan 02). Native tab-bar buttons are
   located by their visible Label (`~Pulse`, …) since the OS renders them, not by a `tab-*` testID;
   screen bodies expose `screen-*` testIDs. The `tab-*` accessibility-id assumption from the plan is
   unverifiable without the sim and is noted here.

## Files created (under `DevDashboard/mobile/` unless noted)

- Toolchain: `babel.config.js`, `metro.config.js`, `tailwind.config.js`, `nativewind-env.d.ts`,
  `tsconfig.json` (aliases + e2e exclude), `package.json` scripts, `src/global.css` (+`@tailwind`),
  `src/theme/tokens.css`.
- Contract bridge: `src/shims/safe-json.ts` (RN-safe SafeJSON), `../../src/dev-dashboard/contract/package.json`.
- Storage: `src/lib/storage/{secure,kv,db}.ts` + `src/lib/storage/__tests__/kv.test.ts`.
- Data/connection: `src/state/connection.ts`, `src/lib/sse-frame.ts` (pure), `src/lib/sse.ts`,
  `src/lib/contract-client.ts`, `src/lib/query.ts`,
  `src/lib/__tests__/{contract-import,sse}.test.ts`.
- Navigation/shell: `src/app/_layout.tsx`, `src/app/(tabs)/_layout.tsx`,
  `src/app/(tabs)/{index,terminal,sessions,qa,more}.tsx`, `src/app/connect.tsx`,
  `src/ui/{Screen,Card,Banner,Loading,Empty,ErrorBoundary,TabPlaceholder}.tsx`.
- E2E: `e2e/{wdio.conf.ts,tsconfig.json}`, `e2e/pages/{base,app}.page.ts`, `e2e/specs/smoke.spec.ts`.
- Removed (template routes that conflicted): `src/app/{index,explore}.tsx`,
  `src/components/app-tabs{,.web}.tsx`.

## Notes for plans 02 / 05–09

- **Connect stub → plan 02** replaces `src/app/connect.tsx` with the tier picker + QR pairing; the
  `setEndpoint(tier, baseUrl, authHeader)` + SecureStore creds flow + `/api/system/pulse` probe pattern
  is in place. E2E keypairs go in `src/lib/storage/secure.ts` under separate keys (never KV/SQLite).
- **Pulse (05)** fills `(tabs)/index.tsx`; the contract client `buildClient().system.pulse()` and
  `pulseHistory()` are ready.
- **Terminal (06)** registers drivers + adds `TerminalPage`; `TerminalDriverId` lives in
  `src/lib/storage/kv.ts` and the prefs round-trip is tested.
- Every feature plan extends the Appium POM under `e2e/pages/` + a spec under `e2e/specs/`.
