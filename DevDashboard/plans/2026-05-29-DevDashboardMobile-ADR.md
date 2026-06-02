# DevDashboard Mobile + Product — Architecture Decision Record (ADR)

> **Read this before any subsystem plan.** It freezes the cross-cutting decisions every plan depends
> on: artifact naming, interfaces (Transport / TerminalRenderer / MetricChart / QaStream), the trust
> model, the verified library stack, the repo layout, and the standing engineering rules. Backed by
> the verified research corpus in `DevDashboard/research/` (files 00–10). Status: **accepted
> 2026-05-29**, with two items pending research workflow `w83na3gs2` (3rd terminal driver; NativeWind
> v5 readiness) — noted inline.

---

## 0. Standing engineering rules (apply to every plan)

1. **Search docs on demand.** Before implementing anything stack-specific, query current docs — `context7` (`/websites/expo_dev_versions_v55_0_0` for SDK 55, `/expo/skills`), the local `expo:*` skills (`expo:building-native-ui`, `expo:native-data-fetching`, `expo:expo-tailwind-setup`, `expo:expo-dev-client`, `expo:expo-deployment`, `expo:use-dom`, `expo:upgrading-expo`), and web search (Jina/Brave). Versions move; never code a native integration from memory. Each plan repeats this in its preamble.
2. **Ask before locking a new library.** Per `[[feedback-ask-before-choosing-libs]]`, surface any new dependency choice with options + a recommendation before adding it. The libraries in §6 are already user-approved.
3. **Appium E2E is mandatory, not optional.** Every feature ships with Appium specs + Page Objects (POM) so implementation can be self-verified and iterated autonomously (see §8). Unit logic uses `bun:test` (Agent/contract) and the RN test runner (mobile pure logic).
4. **New Architecture is mandatory** (SDK 55 removed Legacy Arch). Any native lib must pass the Fabric/TurboModule gate. This already filtered the stack in §6.
5. **Swappability where it's risky.** Transport, terminal renderer, chart renderer, and SSE client each sit behind an interface so a failed pick is replaced without touching feature code.
6. **Never break the web dashboard** during the Agent extraction (M0 gate in plan 01).

## 1. Artifact naming (resolve the "server" ambiguity)

| Artifact | Package / location | What it is |
|---|---|---|
| **DevDashboard Agent** | `src/dev-dashboard/` (`tools dev-dashboard agent`) | On-device server, extracted from `vite-middleware.ts`. Serves `/api/*` + ttyd over the chosen transport. macOS today; platform-abstracted later. |
| **DevDashboard Contract** | `src/dev-dashboard/contract/` → published as local pkg `@devdashboard/contract` | Pure DTOs + endpoint catalog + transport-agnostic typed client. Consumed by Web, Mobile, Agent. |
| **DevDashboard Web** | `src/dev-dashboard/ui/` (existing) | The current React UI; re-pointed at the contract client. No rewrite. |
| **DevDashboard Mobile** | `DevDashboard/mobile/` (new Expo project) | Expo SDK 55 app — the native client. |
| **DevDashboard Cloud** | `DevDashboard/cloud/` (new) | Optional managed tier: landing page + signup + managed provisioning. `high-end-visual-design`. |

**Repo layout decision:** the Agent stays in `src/dev-dashboard/` because it is a `tools` CLI tool wired to `@app/*`, the logger, config, and `lib/*` — moving it would break tool discovery and imports. The standalone *projects* (mobile app, cloud) live under the product umbrella `DevDashboard/` (which already holds `research/`). The **contract** bridges them: authored in `src/dev-dashboard/contract/`, exposed as a local workspace package `@devdashboard/contract` (its own `package.json` with `exports`) so Mobile imports it without inheriting the repo's `@app/*` alias resolution. Web imports it via the existing `@app/dev-dashboard/contract` alias. (Plan 03 + 04 implement the packaging.)

## 2. Server extraction → handler registry (plan 01)

Decision: lift routing into a transport-agnostic `Router` + `RouteContext`/`RouteResult`; two adapters (`node-connect` for Vite today, `bun-serve` for the standalone Agent); auth as a shared guard reusing `lib/auth.ts`; pollers behind an explicit `startBackgroundServices()`; macOS telemetry behind a `SystemCollector` interface. `lib/*` untouched. Full task breakdown in `…-01-ServerExtraction.md`. **M0 = web still works, Agent serves `/api` standalone.**

## 3. Shared contract (plan 03)

Decision: `@devdashboard/contract` is a **pure, RN-bundle-safe** module (guard test forbids value imports from `lib/*` and any `node:`/`bun:` import). It owns the DTOs, the endpoint path catalog, and `createDashboardClient({ baseUrl, fetch, authHeader, eventSourceFactory })`. The SSE subscribe helper takes an **injected** stream factory so web (`window.EventSource`) and mobile (`expo/fetch` parser) plug in without changing the contract. Full breakdown in `…-03-SharedContract.md`.

## 4. Transport abstraction + trust tiers (plan 02)

**`Transport` interface** — the whole app codes against this; tier selection swaps the impl:

```ts
export interface Transport {
  readonly tier: "lan" | "tailscale" | "cloudflared-self" | "managed";
  baseUrl(): string;                                   // LAN ip / tailnet host / tunnel url
  authHeader(): string | undefined;                    // Basic … (from SecureStore), or undefined
  reachable(): Promise<boolean>;                       // tier-specific liveness probe
  streamQa(onRow, onStatus): Disposable;               // expo/fetch SSE under the hood
  openTerminal(sessionId: string): TerminalTransport;  // partysocket-wrapped WS to ttyd (+ cookie/token)
  // managed/cloudflared tiers may wrap all of the above in an E2E layer (see trust policy).
}
```

**SSE:** `expo/fetch` (native streaming; RN core `fetch` has no `ReadableStream` — facebook/react-native#27741 open) + a ~40-line SSE parser mirroring ChatterUI's `SSEFetch.ts`. Fallback `react-native-sse` behind the same `QaStream` interface. Resync model mirrors the web: on `AppState` resume, reconnect + re-fetch the persisted `/api/qa/log` and dedupe by `entry.id` (no `Last-Event-ID` unless we add server event IDs).

**WebSocket (ttyd):** global `WebSocket` + **`partysocket`** (reconnect/backoff/buffer) + app-level ping/pong heartbeat + `AppState` teardown-and-resync. tmux/cmux hold the session server-side; ttyd replays scrollback on reattach. Backgrounding kills sockets — by OS design; do not fight it.

**Trust tiers (all behind `Transport`; user chose "1 + 2" → ship LAN + Tailscale + managed, plus self-hosted cloudflared):**

1. **LAN / mDNS** (`react-native-zeroconf`, New-Arch via Interop Layer; dev-client + local-network perms; Android flaky → prefer DNSSD impl, AppState rescan). Zero third party. Same-Wi-Fi only — a *complement*.
2. **Tailscale / WireGuard (trust-max default)** — the only tier where "we can't see your data" is true by construction (E2E WireGuard; relays see ciphertext). **No embeddable SDK** (tailscale#7240 — `tsnet` is Go-only): the user runs the Tailscale app; our app talks to the tailnet hostname and only *detects reachability + deep-links* to Tailscale. Also supports raw WireGuard for no-account self-host.
3. **Self-hosted cloudflared (guided, frictionless)** — *user-requested.* The Agent ships a **near-zero-friction setup wizard** (`tools dev-dashboard tunnel setup`): auto-detect/install `cloudflared`, walk the CF login, create + route the tunnel, persist config, and emit a **pairing QR** the mobile app scans. The user owns *their* CF account → **the vendor is never in the data path**. Designed for non-technical "vibecoders": one command, copy-paste-free, with a fallback printed-steps guide. (CF still terminates TLS, but it's *the user's own* CF account, not the vendor's — honest "the vendor can't see your data".)
4. **Managed-convenience (vendor-operated) — ONLY with app-layer E2E.** A vendor relay/tunnel for one-tap remote with no setup. Because CF (or any vendor relay) terminates TLS, the no-see claim survives **only** with **endpoint-to-endpoint encryption above the transport**: X25519 ECDH at pairing (QR/device-link code) → per-message AEAD (NaCl `crypto_box` / Noise). **Keys live only on the phone (Secure Enclave/Keystore) and the Mac; the vendor never escrows them.** Terminal I/O + SSE + WS frames are encrypted inside the payload; the relay forwards opaque ciphertext (+ metadata). Plan 02 + 10 detail the pairing UX and key custody.

5. **Managed-(sub)domain cloudflared (OPTIONAL sub-variant of tier 3/4) — user-requested.** For users who run their **own `cloudflared`** but **lack a domain**, the vendor optionally **provides/manages a (sub)domain** (e.g. `<name>.devdashboard.app`) so they still get a clean stable URL without buying a domain. Implementation options (plan 02/10 decide): **Cloudflare for SaaS / custom hostnames** routing a vendor-owned subdomain to the user's tunnel, or a vendor wildcard zone. **Trust caveat:** if the vendor's CF account fronts the subdomain, the vendor's edge terminates TLS → this inherits the **managed-tier E2E requirement** (tier 4) for an honest no-see claim. Purely DNS-delegated-to-the-user's-own-CF variants keep tier-3 trust. Strictly opt-in; the default remains "bring your own domain / Tailscale".

**Trust policy (marketing must match architecture):** "we cannot see your data" is stated unconditionally **only** for LAN, Tailscale/WireGuard, and self-hosted-cloudflared (user's own account). For the vendor-managed tier it is stated **as a property of the E2E layer**, with the metadata caveat. No tier claims more than it delivers.

## 5. Terminal renderer (plan 06)

**`TerminalRenderer` interface** (verified, renderer-agnostic — no WebView/URL/injectJS leaks into the contract; full TS in `DevDashboard/research/06-terminal-recommendation.md`): `attach/detach/sendInput/sendKey/paste/scroll/scrollPage/fit/resize/focus` + `onData/onStatus/onExit/onSelection` callbacks + `status`.

Decision (per user): **ship BOTH WebView drivers and an in-app driver switcher**, both fully working, behind `TerminalRenderer`:
- **Driver A — `WebViewTtydRenderer`**: `react-native-webview` → existing `/ttyd/<id>/` URL (set via **ref**, not the reactive prop). Reuses the server's `injectTtydMobileShell`. Requires the **`patch-package` #3880 native diff** (iOS New-Arch `source`-prop bug #3863; verified working on Expo 55) + native cookie planting (`@react-native-cookies/cookies`) for the `dd_session` WS auth + the `TtydFrame` readiness probe.
- **Driver B — `WebViewHtmlRenderer`**: local xterm.js HTML + self-opened ttyd WebSocket with the auth **token in the WS subprotocol** (no cookie dependency). Owns its xterm client + WS framing.
- **In-app switcher**: a Settings toggle (persisted in `expo-sqlite/kv-store`) selects the active driver; both are registered. Default = A; auto-suggest B if A's cookie auth fails the device spike.
- **Driver C (pending `w83na3gs2`)**: a possible 3rd driver from the open-source hunt (Termius/Termix/etc.). If the synthesis (file 10) finds a viable RN-embeddable option, it plugs in as a third registered driver; otherwise the two-WebView plan stands. Plan 06 leaves the registration seam ready.

**Required device spike (plan 06 Task 0):** on a real iOS dev-client with #3880 patched, confirm (a) `/ttyd/<id>/` renders a live terminal and (b) `dd_session` cookie auth survives the WS handshake on cold launch. Prop recipe is fixed in file 06 (`keyboardDisplayRequiresUserAction={false}`, `sharedCookiesEnabled`, etc.).

## 6. Mobile library stack (user-approved 2026-05-29)

| Concern | Decision | Notes |
|---|---|---|
| Framework | **Expo SDK 55** / RN 0.83 / React 19.2 | New Arch mandatory. dev-client/prebuild (not Expo Go) — Skia/webview/sqlite need native. |
| Navigation | **expo-router v7** (`~55.0.13`), **native tabs** | File-based; iOS 26 native tab bar. `expo:building-native-ui`. |
| Server state | **TanStack Query v5** | + `onlineManager`/`focusManager` via netinfo + AppState (`expo:native-data-fetching`). |
| Client/UI state | **Zustand** | For cross-screen UI state (active session, driver choice, connection tier). |
| Charts | **victory-native (XL v41)** behind a `MetricChart` interface | Skia GPU; maps onto the web `PulseGraph`. `react-native-graph` optional for sparklines; `@shopify/react-native-skia` is the escape hatch. |
| Theming | **NativeWind v4.2.4 (GA)** to start; **migrate to v5 later** | Research file 09 verdict = `start-v4-migrate-later` (v5 still preview with blocking issues). `--dd-*` tokens map either way. `expo:expo-tailwind-setup`. (User leaned v5; deferred to research — overridable.) |
| SSE | **`expo/fetch`** + parser (`QaStream` iface) | Fallback `react-native-sse`. |
| WebSocket | global `WebSocket` + **`partysocket`** | reconnect/backoff/heartbeat. |
| Secrets | **expo-secure-store** | Basic-auth creds / E2E keys / session secret (Keychain/Keystore). |
| **Key-value** | **`expo-sqlite/kv-store`** (user-chosen, Expo-first) | Drop-in AsyncStorage API over SQLite; no extra native dep beyond expo-sqlite. Theme/driver/last-session prefs. |
| **Relational / offline cache** | **`expo-sqlite`** (user-chosen) | Persist Pulse history, QA log, cached sessions, TanStack Query offline persistence. Reused across features. |
| ~~MMKV~~ | **Dropped** | Optional perf escape hatch only if synchronous micro-reads ever matter; not in v1 (Expo-first preference wins). |
| LAN discovery | **react-native-zeroconf** | Tier 1; `@dawidzawada/bonjour-zeroconf` (Nitro) as alt if interop flaky. |
| Terminal | **react-native-webview** (+ `@react-native-cookies/cookies`, `patch-package`) | Drivers A & B (§5). |
| Animation/gesture | reanimated **4.2.1** + worklets **0.7.4** + gesture-handler **2.30** + screens **4.23** + safe-area **5.6.2** + svg **15.15.3** + skia **2.4.18** | SDK-55 bundled pins; install via `npx expo install`. |
| Background/notify | expo-background-task (`~55.0.17`), expo-notifications (`~55.0.20`) | "build finished / needs input" alerts; iOS bg is best-effort. |

> **Install rule:** native modules via `npx expo install <pkg>` (resolves SDK-55 pins from `bundledNativeModules.json`), not `bun add` — `npm latest` is often the SDK-56 dev line.

## 7. SDK 55 foundation invariants

New Architecture is always-on (no flag). Reanimated 4 + Unistyles 3 are New-Arch-only (a guarantee in our favor). Babel still needs `react-native-worklets/plugin`. Full verified pin table + install recipe in `DevDashboard/research/05-metrics-charts-and-sdk55.md` §B.

## 8. Testing strategy (Appium E2E + POM — user-required)

Decision: the mobile app ships an **Appium** E2E suite from the start so implementation is self-verifiable and the agent can iterate without a human in the loop.
- **Structure:** `DevDashboard/mobile/e2e/` with **Page Objects** (`e2e/pages/*.page.ts`: `PulsePage`, `TerminalPage`, `SessionsPage`, `QaPage`, `ConnectPage`, `SettingsPage`) and **specs** (`e2e/specs/*.spec.ts`). Use the `appium` skill (`appium_*` MCP tools) — accessibility-id locators first; drive via `appium_gesture`.
- **Per-feature requirement:** every feature plan (05–09) ends with an Appium spec + the Page Object methods it needs. A feature is "done" only when its spec passes on the iOS simulator/dev-client.
- **Coverage anchors:** connect/pair flow (each tier reachable-or-graceful), Pulse renders + updates, terminal A & B each open a live shell + accept input + the key bar works, QA stream shows a new entry live, session list + create/kill, settings driver switch.
- **Units:** Agent + contract via `bun:test` (plans 01/03). Mobile pure logic (SSE parser, reducers, key-mapping) via the RN test runner.
- A short **`maestro-e2e`** smoke flow is an acceptable lighter complement, but Appium POM is the required iteration harness.

## 9. Open items pending research workflow `w83na3gs2`

- **3rd terminal driver** (file 10): if a viable RN-embeddable open-source terminal is found, register it as Driver C in plan 06; else two-WebView plan stands. Either way the switcher seam is built.
- **NativeWind v5 readiness** (file 09): if v5 has blocking issues, plan 04 starts on **v4.2.4 GA** with a documented v5 migration path; else v5 from the start. The token-mapping approach (`--dd-*` → `@theme`) is unchanged either way.

## 10. Consequences

- **Positive:** one contract for web+mobile+agent; trust claim is defensible per tier; terminal & transport risk is contained behind interfaces; the macOS-only collector is abstracted for future Linux/Windows; everything ships in this repo/worktree.
- **Costs:** the managed tier's E2E layer is real crypto engineering (pairing, key custody, ratcheting) — scheduled, not hand-waved. The terminal needs a `patch-package` native diff + a device spike. NativeWind v5 carries preview risk (fallback ready).
- **Phasing unchanged** (see `…-00-Overview.md`): Foundation (01 → 03 → 02) → Mobile foundation (04) → Features (05 Pulse, 06 Terminals, 07 QA, 08 Obsidian) → Rest (09) → Cloud (10) → Distribution (11) → E2E (woven throughout, harness in 04).
