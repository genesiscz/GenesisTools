# 21 — Appium E2E foundation (harness) implementation notes

> Isolated worktree off `feat/dev-dashboard-mobile` @ `10981acc5`. All work scoped to
> `DevDashboard/mobile/e2e/` (+ this notes file). `src/api/*`, `src/ui/*`, `src/features/*`,
> `app/(tabs)/_layout.tsx`, `DECISIONS.md`, and the other features' e2e pages/specs
> (terminals/qa/obsidian/rest) were NOT touched. No Metro / `expo start` / simulator / `expo run`
> / Appium server / device was started — these specs are device-only and the user runs them.

## Status: COMPLETE — harness solidified; Connect/Pulse page objects + specs polished; green where verifiable without a device.

- **`bunx tsc -p e2e/tsconfig.json --noEmit`: 0 errors.**
- **`bunx tsc --noEmit` (app): 2 errors — both PRE-EXISTING + out of scope, delta 0 vs the
  pristine `10981acc5` baseline.** See "App tsc baseline" below.
- Use `bunx tsc`, NOT `tsgo`, for the mobile app (tsgo can't resolve RN's `types` export
  condition — carried over from plan-04/05 notes).
- No new e2e libraries added (the WDIO/Appium/Mocha stack was already in `devDependencies`).

## Commits (one per logical step)

| Step | Subject |
|---|---|
| 1 | extend `BasePage` with tap/type/getText/scroll/retry helpers (append-only) |
| 2 | harden `wdio.conf.ts` — env-gated iOS/Android caps, fix `tsConfigPath` resolution |
| 3 | polish Connect/Pulse page objects + specs onto BasePage helpers (public API unchanged) |
| 4 | e2e README — build dev-client, `DD_APP_PATH`, run specs, add-a-feature guide |
| 5 | this notes file |

## Worktree setup note (one-time)

This worktree was created off the WRONG base (`581f71f70`, the `feat/tmux-cmux-dev-dashboard`
lineage — no `DevDashboard/` dir, unrelated CI commits). The 4 sibling agent worktrees all sat at
`10981acc5`. Verified `581f71f70` was reachable from `feat/tmux-cmux-dev-dashboard` + backup
branches (orphans nothing), worktree was clean, then `git reset --hard 10981acc5` to align with the
siblings. The system-prompt `gitStatus` snapshot (showing modified files under
`src/dev-dashboard/ui` etc.) was from a different worktree state and never matched this tree.

## Harness layout

```
e2e/
  wdio.conf.ts            # runner config (capabilities, timeouts, spec glob)
  tsconfig.json           # e2e-only TS config — paths: { "@e2e/*": ["./*"] }; excluded from app tsconfig
  pages/
    base.page.ts          # BasePage abstract — the shared, append-only helper surface
    app.page.ts           # AppPage (appPage singleton) — native tab bar + tab screen roots
    ConnectPage.page.ts   # ConnectPage (connectPage singleton) — connect/pair gate
    PulsePage.page.ts     # PulsePage (pulsePage singleton) — Pulse home tab (D32 reference)
  specs/
    smoke.spec.ts         # app boots → native tabs render
    connect.spec.ts       # tier picker, reachability probe, deep-linked pairing
    pulse.spec.ts         # KPIs/charts/cards render + live CPU reading updates
  README.md               # how to build + run on a device (full ops guide)
```

- **Locators = accessibility ids** via `BasePage.byId(id)` → `$(\`~${id}\`)`. RN `testID` maps to the
  iOS `accessibilityIdentifier` / Android `resource-id`, which Appium's `~` selector resolves.
  Native (OS-rendered) tab-bar buttons have no testID → located by visible label (`~Pulse`).
- **POM convention (D21):** one `*.page.ts` per feature (extends `BasePage`, exports a singleton)
  + one `*.spec.ts` (Mocha BDD + `expect-webdriverio`). So an agent can iterate autonomously.

## BasePage public API (FROZEN — append-only)

The four parallel feature agents subclass `BasePage` and write specs off the SAME commit, so this
surface is append-only. The pre-existing trio kept byte-stable: `byId` (protected),
`waitForVisible`, `isVisible`. Added (additive, no breakage): `waitForExist`, `waitForGone`,
`isExisting`, `tap`, `type`, `appendText`, `getText`, `getAttribute`, `scrollIntoView`,
`scrollAndTap`, `retry`, `waitUntil`, and a `defaultTimeout` field. Also frozen: `AppPage`
(`openTab`, `tabsVisible`, `TabName`, `appPage`), `ConnectPage` (`isShown`, `selectTier`,
`reachabilityLabel`, `isReachabilityState`, `isPairPanelShown`, `isLanListShown`, `tapOpenTailscale`,
`tapTailscaleProbe`, `injectPairing`, `tapContinue`, `connectPage`), and the `@e2e/*` import paths +
the existing filenames. Internals were rewired onto the new helpers but no public signature/name
changed.

## How to add a feature's PageObject + spec

1. Make the screen testable — every screen root + interactive element gets a stable `testID`
   (root: `screen-<feature>`; controls: `<feature>-<thing>`). Connect/Pulse already do this; copy.
2. `e2e/pages/<Feature>Page.page.ts` extends `BasePage`, exports a singleton (`export const
   <feature>Page = new <Feature>Page()`), leans on the inherited helpers.
3. `e2e/specs/<feature>.spec.ts` — in `before()` clear the connect gate
   (`if (await connectPage.isShown()) await connectPage.pairWithTestAgent();`), open the tab
   (`await appPage.openTab("<Tab>")`), then assert.
4. Import via `@e2e/*` ONLY (e2e tsconfig has no `@/`/`@dd/` paths — pulling those in breaks e2e
   tsc). No `as any` (D-style). Type-gate: `bunx tsc -p e2e/tsconfig.json --noEmit` = 0.

## Running on a device (full guide in `e2e/README.md`)

1. Build a dev-client (D3, New Arch, NOT Expo Go): `bun expo run:ios` / `bun expo run:android`.
2. `export DD_APP_PATH=<path to built .app / .apk>`.
3. `bun run e2e:appium` (Appium on :4723) in a separate shell.
4. `bun run e2e` (iOS default) — or `DD_PLATFORM=android … bun run e2e`.

Env: `DD_APP_PATH`, `DD_PLATFORM`, `DD_SIM_DEVICE`/`DD_SIM_OS`, `DD_AVD`/`DD_EMU_OS`, `DD_BUNDLE_ID`.

## What is device-only (NOT runnable in this sandbox / by an agent here)

- Everything in `specs/` — needs a booted iOS Simulator / Android Emulator + an Appium server +
  the built dev-client binary. No device is present here, so specs are AUTHORED, never executed.
- The connect-gate clear needs a **test Agent running at `http://127.0.0.1:3042`** with Basic auth
  satisfied (an empty password 401s the probe — plan-04 note, `13-impl-04-notes.md`). The deep-link
  pairing (sim has no camera) is `connectPage.pairWithTestAgent()`.
- The Skia chart canvas is opaque to the a11y tree → "chart renders" is asserted via the chart
  CONTAINER testID being displayed, never the canvas pixels.

## OPEN DECISION / FLAG (D20) — Android driver not installed

`wdio.conf.ts` declares an Android (`UiAutomator2`) capability, but the `appium-uiautomator2-driver`
is **NOT** a dependency (only `appium-xcuitest-driver` is). iOS is the default lane (`DD_PLATFORM`
unset → iOS), so its absence never blocks the iOS run or either tsc gate. Enabling the Android lane
needs `appium driver install uiautomator2` (or adding the dep). Per D20 (Expo-first, ASK before
locking any new library) this was left UNINSTALLED and flagged rather than added unilaterally.

## App tsc baseline (why "stay 0" reads as "delta 0" here)

`bunx tsc --noEmit` (app) reports **2 errors, both pre-existing and out of scope**:

```
../../src/dev-dashboard/lib/e2e/box.ts(7,18): error TS2307: Cannot find module 'tweetnacl' …
../../src/dev-dashboard/lib/e2e/box.ts(8,22): error TS2307: Cannot find module 'tweetnacl-util' …
```

- `tweetnacl` + `tweetnacl-util` ARE installed in `DevDashboard/mobile/node_modules` (D29), but the
  failing file is the **repo-root Agent file** `src/dev-dashboard/lib/e2e/box.ts` (pulled into the
  mobile type graph via the `@dd/*` → `../../src/dev-dashboard/*` alias). It resolves those deps
  from the repo-root context, which doesn't carry them → TS2307.
- Verified PRESENT + importing `tweetnacl` at the pristine `10981acc5` (`git show
  10981acc5:src/dev-dashboard/lib/e2e/box.ts`), i.e. before any commit in this worktree. The file is
  in FROZEN territory (`src/dev-dashboard/*`, owned by the Agent extraction, not this task) and was
  not touched. Do NOT "fix" via tsconfig surgery — that would mask real errors.
- The achievable bar is therefore **delta-zero against the captured baseline**: after all edits, app
  tsc is the same 2 errors, nothing new. The e2e tsc gate is the one fully under this task's control
  and is 0.
