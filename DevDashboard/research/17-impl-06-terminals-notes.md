# 17 — Feature: Terminals (tmux / cmux / ttyd) (Plan 06 / D12) implementation notes

> Isolated worktree off `feat/dev-dashboard-mobile @ 10981acc5`. All work scoped to
> `DevDashboard/mobile/`. `src/api/*`, `src/ui/*`, `app/(tabs)/_layout.tsx`, the existing
> `app/(tabs)/terminal.tsx` + `sessions.tsx` placeholders, other `src/features/*`, and `DECISIONS.md`
> were NOT touched (consumed read-only). No Metro / `expo start` / simulator / `expo run` was started —
> device builds + Appium runs + on-device WebView terminal rendering are the user's job.

## Status: COMPLETE — terminals feature built, committed, green where verifiable without a sim.

- **`bunx tsc --noEmit` (app): 0 NEW errors.** Only 2 pre-existing baseline errors remain, both in
  `@dd` e2e box code (`src/dev-dashboard/lib/e2e/box.ts` can't resolve `tweetnacl`/`tweetnacl-util`
  from the repo root) — present BEFORE this plan, unrelated to terminals.
- **`bunx tsc -p e2e/tsconfig.json`: 0 errors.**
- **`bun test src/`: 87 pass / 1 fail.** The +34 new tests (keymap 10, queries 12, registry 4,
  bridge 8) all pass; the 1 fail is the same pre-existing `tweetnacl` `@dd` e2e box error (baseline
  was 53 pass / 1 fail). Zero terminals test failures.
- **`expo lint`: 0 problems.**
- Used `bunx tsc` NOT `tsgo` per the plan-04/05 caveat (tsgo can't resolve RN's `types` export
  condition).

## Commits (one per logical step)

| Step | Commit | Subject |
|---|---|---|
| 1 | `2230c8b12` | TerminalRenderer seam + pure keymap (+ react-native-webview dep) |
| 2 | `1ac17dd31` | data layer — queries/hooks over tmux/ttyd/cmux (D32) |
| 3 | `386df921a` | persisted driver store + driver registry (switcher seam) |
| 4 | `c0c5065d1` | Driver B bridge protocol + Driver A ttyd inject helpers |
| 5 | `e76571982` | patch react-native-webview #3880 via **bun patch** |
| 6 | `929ff0b83` | Driver A (ttyd WebView) + Driver B (xterm.js host + WS) + inlined host generator |
| 7 | `71ee3f24e` | MobileKeyBar + in-app DriverSwitcher + SessionsList |
| 8 | `d75bb482a` | terminals screen — master-detail + active-driver terminal + key bar + switcher |
| 9 | `08f8885b7` | Appium Page Object + spec (authored; device-only run) |
| lint | `ab60a565e` | drop unused eslint-disable from generated host |
| review | `3480fa700` | wire ttyd Rename (Alert.prompt) + close Driver B WS on unmount |

## What was built (all under `DevDashboard/mobile/`)

**Feature-local (`src/features/terminals/`)** — mirrors `src/features/pulse/` exactly:
- `TerminalRenderer.ts` — the renderer-agnostic seam (interface + `TerminalKey`/`TerminalStatus`/
  callbacks). **Re-uses** the foundation's `TerminalDriverId` from `src/lib/storage/kv.ts` (the union
  that already types the persisted `dd.terminalDriver` pref) instead of redeclaring it.
- `keymap.ts` (+ `keymap.test.ts`) — pure `TerminalKey`/char → byte sequences (Esc/Tab/arrows/Pg,
  Ctrl-letter → control code, Alt → ESC prefix).
- `queries.ts` + `hooks.ts` (+ `queries.test.ts`) — **D32 data layer**: co-located `terminalsKeys` +
  `queryOptions` factories over the injected `DashboardClient` (`tmux.sessions`, `ttyd.list`,
  `cmux.snapshot/layout`) + thin `use*` read hooks + `useSpawnTtyd`/`useKillTtyd`/`useRenameTtyd`/
  `useCreateTmux` mutation hooks (invalidate the session inventory on success). Components consume
  THESE — never raw `useQuery`/`useMutation`.
- `driver-store.ts` — persisted Zustand store bridging `getPref/setPref("dd.terminalDriver")` for the
  in-app switcher. Default `webview-ttyd`.
- `registry.ts` (+ `registry.test.ts`) — driver registry (`registerDriver`/`listDrivers`/
  `resolveDriver`). Drivers self-register via module-load side-effects; `"native"` reserved/unregistered.
- `bridge.ts` (+ `bridge.test.ts`) — Driver B RN↔WebView protocol (`injectBytes`/`injectFit`/
  `injectScroll`/… + `parseBridgeMsg`). Cribbed `@fressh` shape, not depended-on.
- `inject.ts` — Driver A `injectJavaScript` builders (synthetic keydown on `.xterm-helper-textarea`;
  scroll via the server-injected `__ddTtydScroll`/`__ddTtydScrollPage`). Ported from the web
  `iframe-keys.ts`, but run in the ttyd PAGE's own context (Driver A loads ttyd as the page, not a
  cross-origin iframe).
- `scripts/build-xterm-host.ts` + `xterm-host.generated.ts` — build-time generator that inlines
  `@xterm/xterm` (JS+CSS) + `@xterm/addon-fit` + the bridge glue into a committed 499 KB HTML string.
- `components/`:
  - `WebViewTtydRenderer.tsx` — **Driver A** (`<WebView source={{uri}}>` → `/ttyd/<id>/`).
  - `WebViewHtmlRenderer.tsx` — **Driver B** (`<WebView source={{html}}>` + `transport.openTerminal()`).
  - `drivers.ts` — barrel importing both (side-effect registration entry point).
  - `MobileKeyBar.tsx` — sticky-Ctrl + Esc/Tab/arrows/PgUp-Dn/Paste/punctuation, touch-tuned.
  - `DriverSwitcher.tsx` — in-app driver picker (segments per registered driver).
  - `SessionsList.tsx` — tmux/ttyd/cmux inventory + Open/Kill/New actions.

**Screen:** `src/app/(tabs)/terminals.tsx` — single-tab master-detail (sessions list ↔ selected-session
terminal surface in the active driver + key bar). Imports `components/drivers` for registration.

**E2E:** `e2e/pages/TerminalsPage.page.ts`, `e2e/specs/terminals.spec.ts` (authored, not run).

**Native dep:** `react-native-webview@13.16.0` (`npx expo install` — SDK-55-resolved; the bundled
version, New-Arch-only per D3). **Build-time devDeps:** `@xterm/xterm@6.0.0`, `@xterm/addon-fit@0.11.0`
(inlined into the host HTML; NEVER imported by RN at runtime → not a runtime/native dependency).

## D12 compliance — both drivers + in-app switcher

- **Driver A** = `react-native-webview` → existing `/ttyd/<id>/` URL. #3863 mitigated via the plan's
  **remount-via-key** (each attach is a fresh initial mount, sidestepping the source-prop-UPDATE bug)
  AND the native #3880 patch (belt-and-suspenders for the update path). Keys/scroll via injected JS
  against the ttyd page's own `.xterm-helper-textarea` + the server's `__ddTtydScroll`. Crash hook
  `onContentProcessDidTerminate` → `onExit("crash")` + auto-remount.
- **Driver B** = `react-native-webview` local xterm.js HTML + a self-opened ttyd WS via the plan-02
  `transport.openTerminal(sessionId)` (`terminal-ws.ts` — `tty` subprotocol, heartbeat, AppState
  reconnect already built; NOT hand-rolled). Token rides the WS subprotocol → **no cookie needed**.
  WS frames → base64 → `injectBytes`; page keystrokes → `postMessage` → `transport.send`. Crash hook
  → remount + re-attach on the page's `ready`.
- **In-app switcher** = `DriverSwitcher` writing the persisted `useDriverStore`; flipping it
  detaches+reattaches the open session. Lives **in the Terminal screen** (D12 says "in-app switcher",
  does not mandate Settings — keeps it feature-local, no `more.tsx`/Settings edit).
- **No 3rd driver** (research 10): `"native"` (SwiftTerm) reserved in the union + a `RENDERER SWAP
  POINT:` comment marks where `@xterm/xterm` → `ghostty-web` could swap inside Driver B.

## patch-package status → switched to **bun patch** (documented deviation from plan-06)

The plan called for `patch-package` + a `postinstall` hook. **patch-package 8's MAKE phase does not
work under bun**: it requires an npm/yarn/npm-shrinkwrap lockfile (errors "No package-lock.json … you
must use npm@>=5, yarn, or npm-shrinkwrap") because it fetches a *pristine* package copy via those
tools to diff against; it doesn't read `bun.lock`. This is the "patch-package setup is non-trivial"
case the brief named.

**Resolution:** used bun's native `bun patch` mechanism instead — it generated
`patches/react-native-webview@13.16.0.patch` (the exact #3880 diff: gives the empty `newSource`
custom-prop body the real `[view setSource:json]` implementation), wired `patchedDependencies` in
`package.json`, and bun **re-applies it on every `bun install`** (verified: removed/reinstalled a dep,
the patch auto-re-applied to `node_modules`). This is MORE robust than patch-package's postinstall
(lockfile-tracked, not a script). `patch-package` was removed from devDeps (unused). The `postinstall`
hook the plan specified is therefore NOT present — bun's `patchedDependencies` is the mechanism.

- **Device-unverified:** the patch is an iOS native `.mm` change that only takes effect in a prebuilt
  dev-client on a device. Not verifiable in this sim-less env. The remount-via-key strategy in Driver A
  means the patch is belt-and-suspenders, not a hard gate.

## Lib flags (D20)

- **`@xterm/xterm` + `@xterm/addon-fit`** — IN the plan (Task 4), added as **devDeps** (build-time
  inline only, not runtime/native). Not a STOP-and-flag case. NOTE: Driver B bundles xterm at build
  time via `scripts/build-xterm-host.ts`; re-run it after bumping `@xterm/*`.
- **`@react-native-cookies/cookies` — NOT added (D20 flag).** The plan's Driver A cookie-plant called
  for this NEW native lib. Per the brief ("ONLY react-native-webview (+ patch-package) … STOP+flag for
  any new lib"), it was not added. Consequence below.
- **Clipboard lib (`expo-clipboard`) — NOT added (D20 flag).** The MobileKeyBar's Paste key delegates
  to an `onPaste` callback the screen supplies; with no clipboard module in-project it is a documented
  no-op. `expo-clipboard` is the Expo-first choice if the user approves adding it.

## ⚠ FLAGS for the orchestrator / follow-up

1. **Tab registration (one-liner, orchestrator owns it).** The screen is at
   `app/(tabs)/terminals.tsx` but is NOT wired into `app/(tabs)/_layout.tsx` (DO-NOT-TOUCH shared
   file). Register `<NativeTabs.Trigger name="terminals">` in the consolidation pass. The existing
   placeholder tabs `terminal.tsx` (`screen-terminal`) + `sessions.tsx` (`screen-sessions`) are
   **superseded** by this single `terminals` screen — reconcile/remove them. Also extend
   `e2e/pages/app.page.ts`'s `TabName`/`TAB_SCREEN` with `"Terminals" → "screen-terminals"` (the
   terminals spec deliberately navigates via the raw `~Terminals` a11y id to avoid editing that shared
   harness file pre-registration).
2. **Driver A has NO working cold-launch auth (non-functional, not just unverified).** The real
   `dd_session` cookie is minted HttpOnly by the front-proxy → unsettable from JS, and
   `injectedJavaScriptBeforeContentLoaded` runs after navigation begins (too late for the initial WS
   handshake). So Driver A's `cookiePlantJs` is effectively a no-op. **Driver B is the robust default**
   (cookie-free WS subprotocol). Device follow-ups to make A work WITHOUT a new lib: the RNCWebView
   **`basicAuthCredential`** prop (plant Basic auth natively) — noted in `WebViewTtydRenderer.tsx`.
   With a new lib: `@react-native-cookies/cookies` (the plan's original path; D20 ask).
3. **No NEW shared `src/ui/` primitive was created.** Everything is feature-local or composes existing
   Tier-1 primitives (`Card`/`ListRow`/`SectionHeader`/`StatusPill`/`Empty`/`MockBadge`). The
   feature-local `ActionButton` (inside `SessionsList`) and the key-bar buttons are candidates the
   orchestrator MAY promote to `src/ui/` later — not promoted here (parallel agents must not touch
   `src/ui/*`).
4. **`mock-client.ts` was sufficient — NOT edited.** Its tmux/ttyd/cmux fixtures cover every endpoint
   the feature reads/mutates (verified by `queries.test.ts`). No fixture gaps found.

## Device-only deferrals (require a simulator / real device — the user's job)

1. **All WebView terminal RENDERING is inherently device-only.** Neither driver paints a terminal
   without a real WebView/DOM (Expo Go can't run the dev-client native modules either). Build the
   dev-client (`npx expo run:ios` — first run prebuilds `ios/` with react-native-webview + the #3880
   patch under New Arch) to see anything.
2. **Driver A live ttyd render + cookie auth on cold launch** — see flag #2; expected to FAIL auth
   until `basicAuthCredential`/cookie module lands. Driver B is the path to verify first.
3. **Driver B live xterm.js render + WS attach** — the 499 KB inlined host HTML's `term.write`/
   `onData`/`__ddFit` glue is generator-verified (the script asserts the bridge globals are present)
   but the on-device GPU/canvas render + the base64 WS round-trip are unverifiable here.
4. **`#3880` native patch efficacy** — iOS New-Arch only, dev-client only (see patch status).
5. **MobileKeyBar above-keyboard positioning + iOS keyboard raise** (`keyboardDisplayRequiresUserAction:
   false`) — runtime/device behavior.
6. **The terminals Appium spec (`e2e/specs/terminals.spec.ts`)** — authored + type-checks; NOT run
   (no sim, and WebView terminals are device-only). To run: register the tab (flag #1), build the
   dev-client, `DD_APP_PATH=…`, `bun run e2e:appium`, then `bun run e2e`. It pairs via a deep-linked
   pairing URI first (gate opens), opens the Terminals tab, opens a session in Driver A, exercises the
   key bar, flips to Driver B, reopens. Needs a test Agent with a live tmux/ttyd session reachable at
   the paired baseUrl with Basic auth satisfied.

## Per-feature pattern adherence (the plan-05 contract)

Followed `16-impl-05-pulse-notes.md` exactly: shared infra (`src/api/*`, `src/ui/*`) consumed
read-only; feature owns `src/features/terminals/{queries,hooks}.ts` (co-located `terminalsKeys` +
`queryOptions` factories over the injected client) + thin `use*` hooks (components never call raw
`useQuery`/`useMutation`) + `components/` + its single tab screen. Touched ZERO shared files — no
merge-conflict surface with parallel feature agents.

## Coordinator ping note

No SendMessage/agent-to-coordinator tool exists in this agent's environment. The flags above (esp.
tab registration #1 and Driver A auth #2) are surfaced in the final report for the parent to relay.

## 2026-05-30 — Post-review addendum (advisor pass)

- **Rename is now wired (was a gap).** Step-1 review caught that `useRenameTtyd` existed + was
  mock-tested but had NO UI affordance, so the "spawn/kill/rename/create" claim was an overclaim that
  tsc/test/lint structurally couldn't catch. Fixed in `3480fa700`: each ttyd row now has a **Rename**
  `ActionButton` (`btn-rename-<id>`) that raises an iOS `Alert.prompt` (RN core, no new lib — this app
  is iOS-first; guarded to a no-op where `Alert.prompt` is undefined) and calls `rename.mutate({id,
  name})`. The e2e spec + Page Object got a matching `renameButtonExists`/`tapRename` + assertion. The
  notes' "flow through the SessionsList's hooks" claim is now accurate.

- **Two device-only runtime caveats (added to the deferrals — unverifiable here, NOT blocking):**
  1. **Double-attach on open.** Each driver seeds `active` from the `session` prop AND the screen's
     `useEffect([open, driverId])` calls `attach()` (which bumps `mountKey`). So opening a session
     mounts the WebView from the prop, then immediately remounts from `attach` → ttyd double-loads /
     the WS re-opens once. Functional but wasteful; the device fix is to drive purely by the
     imperative `attach()` (don't seed `active` from the prop) OR purely by the prop, not both. Left
     as-is because the correct choice depends on observed on-device attach timing.
  2. **WS leak on driver switch — FIXED in `3480fa700`.** Flipping the driver unmounts the old
     `DriverComponent` and mounts the new one; the screen attaches the new ref but never detaches the
     unmounted one. `WebViewHtmlRenderer` now closes its `wsRef` socket in a `useEffect(() => () =>
     wsRef.current?.close(), [])` unmount cleanup, so the old ttyd WS no longer leaks on a flip.
     (Driver A holds no socket — its WS lives inside the WebView/ttyd page, torn down with the WebView.)
