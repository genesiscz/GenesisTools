# 15 — Transport & Trust (Plan 02), MOBILE side — implementation notes

> Worktree `feat/dev-dashboard-mobile`, branch committed directly (no new branch). All work
> scoped to `DevDashboard/mobile/`. The Agent side (`src/dev-dashboard/`) is owned by a
> parallel agent and was NOT touched (read-only references only). No Metro / `expo start` /
> simulator / `expo run` was started — device builds + Appium runs are the user's job.

## Status: COMPLETE — all 14 mobile-side tasks built, committed, and green where verifiable without a sim.

- **`bunx tsc --noEmit`: 0 errors** across the whole mobile app.
- **`bun test src/`: 41 pass / 0 fail across 12 files** (31 new this plan + 10 from plan 04).
- **`expo lint`: 0 problems** (config bootstrapped this session; see Deviations).
- **Box-cipher wire-compat (the headline deliverable): PASS — mobile ciphertext EQUALS the
  frozen Agent vector.** `toBase64(seal(...))` == `E2E_TEST_VECTORS.ciphertextBase64`
  (`0rQ1UN/PhP2FfEFpRCl+hxTJ5vF6Rm9fuwvHZqMQTrJwdPb1DCWR73jKOD+uKg90uxR4bNcfy7woU+M=`),
  proving the phone (tweetnacl) and Mac (tweetnacl) produce byte-identical `nacl.box`
  ciphertext. The vector uses a FIXED nonce, so no PRNG seeding was needed for this proof.

## Commits (one per task; chronological)

| Task | Commit | Subject |
|---|---|---|
| 1 | `7f9f3509d` | Transport/QaStream/TerminalTransport interfaces (ADR §4) |
| 2 | `1a1a37733` | SSE framer + expo/fetch streamSse |
| 3 | `62da4e63b` | QaStream over expo/fetch SSE with id-dedupe resync |
| 4 | `dde851006` | TerminalTransport over partysocket + heartbeat + AppState teardown |
| 9 (mobile) | `8c7b95062` | BoxCipher (tweetnacl) + E2eEnvelope re-export, locked to shared vectors |
| 5 | `29f5f40bf` | PlainTransport base (contract client + SSE + ttyd WS) |
| 6b | `b8d394217` | LAN tier — zeroconf discovery + PlainTransport (Tier 1) |
| 7 | `e71c08ea8` | Tailscale tier — tailnet probe + deep-link + reachability FSM (Tier 2) |
| 8 (mobile) | `96737a14e` | self-cloudflared tier — scanned pairing URI -> PlainTransport (Tier 3) |
| 11 | `7996f954d` | E2eTransport decorator + managed tier (vendor relay sees only ciphertext) |
| 12 | `51c94bf21` | connection store (Zustand) + pairing-QR parser |
| (fix) | `35b41ef77` | narrow TerminalTransport.send to partysocket Message type |
| 13 | `2c9670485` | Connect/Pair screen — tier picker + QR scanner + reachability UI |
| 14 | `d1b12e9ba` | ConnectPage Appium spec + Page Object (transport done-gate) |
| (chore) | `a67275229` | expo lint setup + drop zeroconf plugin entry + array-type fixes |

## Library installs (all per plan / DECISIONS — no new lib decision required)

- `bun add partysocket@1.1.19 tweetnacl@1.0.3 tweetnacl-util@0.15.1` (pure-JS, D29).
- `npx expo install react-native-zeroconf@0.14.0 expo-camera@55.0.19` (native, SDK-55-resolved).
- `eslint-config-expo@55.0.1` was auto-installed by `expo lint` on first run (dev-dep).

**No unplanned library decisions** — nothing needed escalating to the orchestrator (D20).

## Key deviations from the plan (and why)

1. **Imports: `@dd/contract` + `@/`, not the plan's `@app/dev-dashboard/contract`.** D30
   (locked after the plan was written) mandates `@dd/*` → `src/dev-dashboard/*` and `@/*` →
   mobile `src/*`. Every mobile file uses those; `@app/utils/json` resolves to the RN-safe
   shim. The contract re-exports everything via `@dd/contract` so the plan's symbol set is
   intact (`createDashboardClient`, `makeBasicAuthHeader`, `decodeEnvelope`, `E2eRequest`, …).

2. **Test runner: `bun:test`, not `@jest/globals`.** The scaffold's runner is `bun test src/`
   (per `package.json`). All test files use `import { describe, expect, it, mock } from "bun:test"`.

3. **Native-import isolation via `mock.module` + dynamic `import()` in tests.** The plan's pure
   modules statically import native packages (`expo/fetch` → drags `react-native`'s Flow entry
   bun can't parse; `partysocket`; `react-native`; `expo-secure-store`). To keep the SOURCE
   clean (static top-level imports, no inline dynamic imports per user pref) AND run the pure
   logic under bun, each affected test does `mock.module("<native>", () => …)` then
   `await import("<module under test>")` — the exact pattern plan-04's `kv.test.ts` established.
   This is why `sse-parser` / `qa-stream` / `terminal-ws` / `plain-transport` / `box-cipher` /
   `managed` tests open with a mock block. Pure modules with no native imports
   (`reachability`, `qr`, `envelope`) import directly.

4. **`QaRow`, not the plan's `QaEntry`, for the QA stream.** The contract has no `QaEntry`
   export; the stream emits `QaRow` (extends the base `QaEntry` from `@app/question/lib/types`
   + `EnrichedQaEntry`) — it is the type with the `id` field the dedupe keys on. `Transport.ts`
   `QaStream.connect(onRow: (entry: QaRow) => void, …)`.

5. **`test-vectors.ts` (not `.json`).** The Agent shipped frozen vectors as a `.ts` const
   `E2E_TEST_VECTORS` at `@dd/lib/e2e/test-vectors` (avoids `resolveJsonModule` under the repo's
   `verbatimModuleSyntax`). `box-cipher.test.ts` imports that const — it is pure data, safe to
   import; it is a TEST-only import, never bundled.

6. **Managed wire format coded to the SHIPPED contract, NOT the plan's draft.** The plan's
   Task 11 `e2e-transport.ts` used an ad-hoc `"METHOD path\n\nbody"` string POSTed to
   `/api/e2e/exchange`, and its loopback test asserted `echoed: "GET /api/system/pulse\n\n"`.
   Those predate `contract/e2e-request.ts`, which the Agent shipped afterwards. Per that file's
   own header + the task brief, the real wire is: encode an **`E2eRequest`** `{method, path, body}`
   → seal → POST **`/api/e2e/rpc`** → open an **`E2eResponse`** `{status, body, contentType}`.
   `e2e-transport.ts` is built against `encodeE2eRequest`/`decodeE2eResponse` from `@dd/contract`;
   `managed.test.ts` wires the REAL `createE2eShim` (imported via `@app/dev-dashboard/server/...`
   in the test only) whose `handle` decodes the `E2eRequest` and returns an `encodeE2eResponse`.
   The loopback asserts `echoed === "GET /api/system/pulse"` (no trailing `\n\n`).

7. **Tab-gate bridge (advisor catch).** Root `_layout.tsx`'s `Stack.Protected guard={baseUrl
   !== null}` reads the **foundation** `useConnection` store (plan 04), but plan 02's new
   `useConnectionStore` only tracks `tier`/`transport`. Without a bridge the gate would stay
   shut after connect. Fix: each `useConnectionStore` setter, after building the transport,
   calls `useConnection.getState().setEndpoint(tier, baseUrl, authHeader)` + `setStatus("connected")`
   via a `publishToGate(transport)` helper. So connect → tabs works.

8. **Route file at `src/app/connect.tsx`** (the scaffold's expo-router root is `src/app/`), not
   the plan's top-level `app/connect.tsx`. Replaced the plan-04 debug stub in place. The new
   screen is functional (not just an a11y skeleton): tier picker + per-tier credential inputs
   (LAN/Tailscale host+user+pass, self-cloudflared password) + QR scanner for pairing tiers +
   reachability badge + Continue. Every interactive element keeps a stable `accessibilityLabel`
   for Appium.

9. **`app.config.ts` via the MERGE form, and `react-native-zeroconf` is NOT a plugin.** Created
   `app.config.ts` that loads `app.json` as `config` and spreads it (`...config`, `...config.ios`,
   etc.) so NO app.json key is dropped — verified via `npx expo config --type public` (splash,
   icons, expo-router/secure-store/sqlite/background-task plugins, `reactCompiler`, scheme all
   preserved). Added iOS `NSBonjourServices`/`NSLocalNetworkUsageDescription`/`NSCameraUsageDescription`,
   Android `INTERNET`/`ACCESS_NETWORK_STATE`/`ACCESS_WIFI_STATE`/`CHANGE_WIFI_MULTICAST_STATE`/`CAMERA`,
   the `expo-camera` plugin, and a `devdashboard` deep-link scheme (for the pairing-URI deep link).
   **`react-native-zeroconf` ships no `app.plugin.js`** — listing it in `plugins` makes Expo's
   config loader throw (it also can't parse the package's Flow `index.js`). It's a plain
   autolinked native module; its needs are met by the infoPlist + permissions above, so it is
   intentionally absent from `plugins`. Verified: `expo config` evaluates cleanly without it.

10. **Appium spec/Page Object in the EXISTING WDIO/Mocha harness style**, not the plan's
    `@jest/globals` + standalone-`remote()` pattern. `ConnectPage` extends `BasePage`, uses the
    global `$`/`browser`, locates by `~<accessibility-id>`, and is exported as a singleton
    `connectPage` — exactly like `app.page.ts`/`smoke.spec.ts`. The e2e tsconfig only has
    `@e2e/*`, so the spec is self-contained (pairing URI hardcoded). Type-checks clean against
    `e2e/tsconfig.json`.

11. **`react-native-zeroconf` ambient types.** The package ships NO `.d.ts`. Added
    `src/types/react-native-zeroconf.d.ts` mirroring the runtime API (verified against the
    compiled `dist/index.js`: `scan`/`stop`/`publishService`/`getServices` + the EventEmitter
    `resolved`/`found`/`remove`/`error`/… events + the native `Service` shape).

12. **`expo lint` scoped to ignore `e2e/`.** The auto-generated `eslint.config.js` lints with the
    main tsconfig, which doesn't know the `@e2e/*` alias → false `import/no-unresolved` on the
    WDIO specs (the pre-existing `smoke.spec.ts` hit this too). Added `e2e/*` to ESLint `ignores`;
    `e2e/` is type-checked separately via `tsc -p e2e/tsconfig.json`.

## Bundle safety (plan self-review item #11) — VERIFIED

`rg 'from "@app/dev-dashboard/(lib|server)' src --glob '!**/*.test.ts'` → **ZERO non-test hits.**
Every mobile APP-SOURCE transport/e2e import goes through `@dd/contract` (the RN-safe door).
The only files reaching into Agent `lib`/`server` are bun-only TEST files (never bundled):
- `box-cipher.test.ts` → `@dd/lib/e2e/test-vectors` (pure data const, sanctioned by the task brief).
- `managed.test.ts` → `@app/dev-dashboard/server/transport/e2e-shim` (the REAL shim, for the
  cross-stack loopback proof — sanctioned by the plan).

## Cross-endpoint crypto proofs (what the managed tier rests on)

- **box-cipher.test.ts (4 pass):** mobile `seal` == frozen vector; `open` of the vector recovers
  the plaintext; fresh-key round-trip; tamper → `null`.
- **managed.test.ts (2 pass):** a request the phone's `E2eTransport` encrypts is decrypted by the
  REAL Agent `createE2eShim`, handled, re-encrypted, and decrypted back by the phone — through the
  actual `E2eRequest`/`E2eResponse` contract and `/api/e2e/rpc`. Second case: a wrong-agent-key
  seal fails closed (`reachable()` → false).

## What REQUIRES a simulator / device (DEFERRED to the user)

1. **Build + launch the dev-client** (`npx expo run:ios`) — first run prebuilds `ios/` with the
   merged `app.config.ts` (plist + perms + camera + zeroconf autolinking).
2. **`AbortSignal.timeout(...)` on Hermes (RN 0.83) — UNVERIFIED.** Used in all three plain-tier
   probes (`lan`/`tailscale`/`cloudflared`). Passes `tsc`; may throw at runtime if Hermes lacks
   it. If so, the fix is a manual `AbortController` + `setTimeout` (one shared helper). FLAGGED,
   not fixed blind (per advisor).
3. **`react-native-zeroconf` New-Arch behavior + local-network permission prompt** — native,
   Interop-Layer; only validatable on a real LAN with a running Agent advertiser.
4. **`expo-camera` `CameraView` QR scan on device** — the sim has no camera; the Appium spec
   uses a `mobile: deepLink` injection instead.
5. **tweetnacl PRNG on Hermes (for `keyPair()`/`randomNonce()` at RUNTIME).** The wire-compat
   test uses fixed inputs (no PRNG), so it can't catch a missing CSPRNG. On device, if
   `nacl.box.keyPair()` throws "no PRNG", seed `nacl.setPRNG` from `expo-crypto`
   `getRandomValues` once at app start (D29 note). NOT wired yet (no real keygen path runs in
   tests); add it in the managed-tier bootstrap or `_layout.tsx` when the device build surfaces it.
6. **ConnectPage Appium spec (`connect.spec.ts`)** — authored + type-checks; NOT run (no sim).
   Run: build dev-client, `DD_APP_PATH=…`, `bun run e2e:appium`, then `bun run e2e`. Plan note:
   the 5th case ("reaches the agent") needs a test Agent on `127.0.0.1:3042` with auth disabled
   (or plan-04's password prompt) or the empty/typed password 401s the probe. `DD_BUNDLE_ID`
   overrides the deep-link bundle id (the scaffold sets no explicit bundleId; the plan assumed
   `dev.genesistools.devdashboard`).
7. **NativeWind `var(--dd-*)` rendering** on the new connect components — same plan-04 caveat
   (CSS-custom-property colors resolve only at Metro/runtime; inline hex is the ready fallback).

## Files created (all under `DevDashboard/mobile/`)

- `src/transport/Transport.ts`, `sse-parser.ts`(+test), `qa-stream.ts`(+test),
  `terminal-ws.ts`(+test), `plain-transport.ts`(+test), `e2e-transport.ts`,
  `lan-discovery.ts`, `reachability.ts`(+test).
- `src/transport/tiers/lan.ts`, `tailscale.ts`, `cloudflared.ts`, `managed.ts`(+test).
- `src/transport/e2e/box-cipher.ts`(+test), `envelope.ts`(+test).
- `src/state/connection-store.ts`, `src/lib/qr.ts`(+test).
- `src/app/connect.tsx` (replaced the plan-04 stub).
- `src/components/connect/{TierPicker,QrScanner,ReachabilityBadge}.tsx`.
- `src/types/react-native-zeroconf.d.ts` (ambient types — package ships none).
- `app.config.ts` (merge form), `eslint.config.js` (lint bootstrap, e2e ignored).
- `e2e/pages/ConnectPage.page.ts`, `e2e/specs/connect.spec.ts`.

## Notes for downstream plans

- **Plan 06 (Terminals)** consumes `Transport.openTerminal()` → `TerminalTransport`. On the
  managed tier `wrapTerminalE2e` means the renderer always sees PLAINTEXT frames regardless of
  tier (seal-on-send / open-on-message is internal).
- **Plan 07 (QA)** consumes `Transport.streamQa()` → `QaStream`. The AppState resync (close +
  reconnect + re-fetch `paths.qaLog`, dedupe by `seen` Set) is the consuming hook's job — the
  `QaStream`'s `seen` Set makes the merge idempotent.
- **Plan 10 (Cloud/managed relay)** must mount `/api/e2e/rpc` on the Agent (the shim exists;
  only `/api/e2e/pair` is wired so far) and honor the key-custody invariant (public keys only).
- **`reachable()` probes** call `/api/system/pulse` with Basic auth; an empty password (no creds
  entered) will 401. The connect screen now collects real credentials per tier.
