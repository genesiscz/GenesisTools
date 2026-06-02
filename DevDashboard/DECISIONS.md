# DevDashboard Mobile — DECISIONS (canonical, always-read)

> **⚠️ ALWAYS READ THIS FILE FIRST** when working on DevDashboard Mobile — including **after any
> compaction / new session**. It is the single source of truth for every decision the user has made.
> The project memory (`project-devdashboard-mobile`) points here. The detailed rationale lives in
> `.claude/plans/2026-05-29-DevDashboardMobile-ADR.md`; this file is the quick, authoritative index.
>
> **Format:** the **Locked Decisions** table is the current truth (edit in place; add a dated
> `<!-- changed … -->` note when a row changes). The **Decision Log** below is **append-only**
> (chronological, like a build log) — never rewrite earlier entries.

---

## Locked Decisions (current truth)

| # | Area | Decision | Source |
|---|------|----------|--------|
| D1 | Product | Commercial product, not a personal clone. Trust/verifiability is first-class. | user 2026-05-29 |
| D2 | Workspace | All work in worktree `.worktrees/feat-dev-dashboard-mobile`, branch `feat/dev-dashboard-mobile` (off `90196aecd`). | user |
| D3 | Mobile framework | **Expo SDK 55** (GA Feb 2026, RN 0.83, React 19.2). **New Architecture mandatory** (Legacy Arch removed → every native lib must support Fabric/TurboModules). dev-client/prebuild (not Expo Go). | user + research |
| D4 | Backend | **Extract the backend service** → standalone **DevDashboard Agent** (from `vite-middleware.ts`); `lib/*` untouched; web keeps working. | user (Q4) |
| D5 | Transport | **Pluggable `Transport` interface**; ALL tiers behind it. | user |
| D6 | Tier: LAN | LAN/mDNS via `react-native-zeroconf`; same-Wi-Fi complement; zero third party. | user + research |
| D7 | Tier: Tailscale | **Tailscale/WireGuard = trust-max default**; user runs the Tailscale app, we detect + deep-link (no embeddable SDK — tailscale#7240). | user "support tailscale/vpn", research |
| D8 | Tier: self-hosted cloudflared | Offer the user **their own `cloudflared`** with a **guided, near-zero-friction setup wizard** (auto-install, CF login, tunnel create/route, **QR pairing**) for non-technical "vibecoders". User owns their CF account → **vendor never in data path**. | user 2026-05-29 |
| D9 | Tier: managed | Vendor-operated relay/tunnel for one-tap remote — **ONLY honest with an app-layer E2E** (X25519 ECDH pairing → per-message AEAD; keys ONLY on phone+Mac; vendor never escrows). | user (Q4 "1+2"), research |
| D10 | Tier: managed-domain cloudflared (optional) | **NEW:** for users **without their own domain**, the vendor can **manage the (sub)domain** (e.g. `<name>.devdashboard.app` via Cloudflare for SaaS / wildcard) so they still get a clean URL. Optional. Trust = same as managed (vendor CF terminates TLS → needs the E2E layer). | user 2026-05-29 |
| D11 | Trust policy | "We can't see your data" stated **unconditionally** only for LAN / Tailscale / self-hosted-cloudflared (user's own CF). For vendor-managed + managed-domain it's a property of the **E2E layer** (+ metadata caveat). Marketing must match architecture. | user + research |
| D12 | Terminal | Ship **BOTH** WebView drivers behind `TerminalRenderer` + an **in-app driver switcher**, both working: **A** = WebView→ttyd URL (+ `patch-package` #3880 for iOS New-Arch bug #3863 + native cookie plant), **B** = WebView local-HTML + WS (token in subprotocol). **3rd driver** = from the open-source hunt if viable (else seam stays ready). Native (SwiftTerm) = escape hatch only. | user (Q1), research |
| D13 | Terminal research | Run ≥2 agents hunting open-source terminals (Termius/Termix/Tabby/Blink/…) for a 3rd driver. | user (Q1). Done: workflow `w83na3gs2`. |
| D14 | Charts | **victory-native XL** (Skia) behind a `MetricChart` interface; `react-native-graph` optional for sparklines. | user (Q3), research |
| D15 | Theming | <!-- changed 2026-05-29: research 09 verdict `start-v4-migrate-later` --> **Start on NativeWind v4.2.4 (GA)**, **migrate to v5 later**. Research 09 found v5 still preview with blocking issues, so v4 GA is the safe commercial foundation; `--dd-*` tokens map either way. (User leaned v5 but asked me to defer to research findings — confirm if you'd rather take v5-now.) | user (Q2) + research 09 |
| D16 | Client state | **Zustand** for UI/client state. | user |
| D17 | Server state | **TanStack Query v5** (+ netinfo/AppState wiring); other TanStack where applicable. | user |
| D18 | Navigation | **expo-router v7 native tabs**. | research default, Expo-first |
| D19 | Storage | **`expo-sqlite/kv-store`** for KV + **`expo-sqlite`** for relational/offline cache (Pulse history, QA log, query persistence) + **`expo-secure-store`** for secrets/E2E keys. **MMKV dropped** (Expo-first). | user 2026-05-29 |
| D20 | Libs preference | **Expo-first** packages where possible. **ASK before locking any new library** (present options + recommendation). | user 2026-05-29 |
| D21 | Testing | **Appium E2E mandatory** — Page Objects (POM) + specs per feature so the agent can iterate autonomously. `bun:test`/RN runner for units. | user 2026-05-29 |
| D22 | Docs-on-demand | Plans + implementation must **search current docs on demand** (context7 `/websites/expo_dev_versions_v55_0_0`, `expo:*` skills, web) — never code native integrations from memory. | user 2026-05-29 |
| D23 | Planning | Produce **multiple phased plan files** in `.claude/plans/2026-05-29-DevDashboardMobile-*.md`; full parity, phased; v1 implements **Pulse + tmux + cmux + QA + Obsidian** after the foundation/refactors. | user |
| D24 | Design | Customer-facing landing + managed dashboard use the **`high-end-visual-design`** skill (user's pick). User chooses the visual direction from mockups. | user 2026-05-29 |
| D25 | Research location | Research corpus documented in `DevDashboard/research/`. | user |
| D26 | Skills | Use superpowers (`using-superpowers`, `planning-with-files`, `writing-plans`), the `expo:*` family, `appium`, and the design skills, as part of planning + implementation. | user |
| D27 | Design delivery | **Build ALL 3 landing directions** (Obsidian Terminal / Field Notes / Daylight) as real artifacts in `DevDashboard/cloud/landing/<variant>/`; user decides from the built versions (not from descriptions). | user 2026-05-29 |
| D28 | Audience + roadmap | Primary target = **agent-developers / "vibecoders"**, but **broaden the audience** (SREs/on-call, indie hackers, remote teams, security-conscious orgs, students, agencies, AI-agent operators…) and build a **feature roadmap** to make it a **top-shelf product**. See `DevDashboard/PRODUCT-ROADMAP.md`. | user 2026-05-29 |
| D29 | E2E crypto lib | **`tweetnacl`** (+ `tweetnacl-util` + a `crypto.getRandomValues` CSPRNG shim — `react-native-get-random-values` or `expo-crypto`). Pure-JS NaCl, **1,923★ / public domain**, vs native `react-native-libsodium` (56★, needs prebuild/can't run in Expo Go). X25519 `box` = E2E *above* the managed transport. Chosen on user criterion "most mature/starred/maintained on GH" + pure-JS = zero native modules. NB: "tweetnacl" = *tweet-sized code*, **not** Twitter/X. | user 2026-05-29 |
| D30 | Mobile imports | **No relative imports (`../`, `./`) in mobile app code — everything path-aliased.** `@/*` → `DevDashboard/mobile/src/*` (mobile-internal); `@dd/*` → repo `src/dev-dashboard/*` (shared contract, e.g. `@dd/contract`). Wired in BOTH `tsconfig.json paths` AND Metro `resolver.resolveRequest` so it resolves at bundle time, not just type-check. (`@app/utils/json`→RN-safe shim + `@app/*`→repo `src/` kept only for the contract's own internal re-exports.) The only relative strings allowed are inside the alias *definitions* themselves. | user 2026-05-29 |
| D31 | mDNS advertiser lib | **`bonjour-service`** (user pick over `@homebridge/ciao` and low-level `multicast-dns`). Pure-JS, ~13M weekly npm dl, programmatic `publish()` API, Bun-compatible (`node:dgram`), cross-platform. Agent advertises `_devdashboard._tcp` for the LAN tier (D6). **Supersedes the plan's `dns-sd`-spawn default** (programmatic + cross-platform + testable, no subprocess). | user 2026-05-29 |
| D32 | Mobile data layer | **Components NEVER call raw `useQuery`/`useMutation`.** Each endpoint = a TanStack-v5 `queryOptions` factory in `src/api/queries.ts` (closes over the injected `@dd/contract` dashboard client) + a thin component-facing hook in `src/hooks/use*.ts` (`usePulse()` → `useQuery(pulseQuery())`); screens consume the hooks. Centralized query-key factory. **Mock↔real is swapped at the CLIENT (provider), never at the hooks** — a `MockDashboardClient` returns fixtures so screens render before any connection exists. Confirmed standard via gh_grep (kortix-ai/suna Expo app, Uniswap, Prefect, midday, docmost). | user 2026-05-30 |
| D33 | Cloud landing | **Obsidian Terminal** is THE product marketing landing — port the static design to the cloud web stack (responsive React+Tailwind). | user 2026-05-30 |
| D34 | Cloud web stack | DevDashboard Cloud (landing + auth + customer dashboard) is built on the **repo's existing dashboard stack** — Vite + React + **TanStack Router** mirroring `src/dashboard/apps/web`, served via the `src/utils/DashboardApp` framework, at `DevDashboard/cloud/web/`. Verify it renders with **playwright-mcp**. | user 2026-05-30 |
| D35 | Cloud auth + DB | **Better-Auth + SQLite now, Postgres-driver-ready**, behind a **pluggable** auth interface. ⚠️ AMBIGUITY: the stack answer said "auth same as src/dashboard = **WorkOS**" but the auth answer said "better-auth sqlite" — orchestrator chose Better-Auth + documented WorkOS as the alternate adapter (cheap swap). **Confirm at first wakeup.** DB schema: accounts, devices(paired keys), managed subdomains, settings, subscriptions. | user 2026-05-30 (needs confirm) |
| D36 | Cloud backend scope | **Scaffold REAL provisioning + Stripe, env-gated** (inert without creds): Cloudflare-for-SaaS custom-hostname provisioning (the `requestManagedSubdomain` backend) + Stripe checkout/subscriptions/webhooks. All secrets via env vars + `.env.example`; real CF account / Stripe keys / deploy are the USER's to wire. | user 2026-05-30 |

## Artifact names (avoid the "server" ambiguity)

- **DevDashboard Agent** — on-device server (`src/dev-dashboard/`, `tools dev-dashboard agent`).
- **DevDashboard Mobile** — Expo app (`DevDashboard/mobile/`).
- **DevDashboard Web** — existing React UI (`src/dev-dashboard/ui/`), re-pointed at the contract.
- **DevDashboard Cloud** — managed tier: landing + signup + provisioning (`DevDashboard/cloud/`).
- **`@devdashboard/contract`** — shared DTOs + endpoint catalog + typed client.

---

## Decision Log (append-only — newest at bottom)

### 2026-05-29 14:xx — Kickoff
- User: build an Expo SDK 55 RN app cloning the dev-dashboard ("T-Max/CMax/Pulse" = tmux/cmux/Pulse +
  the rest). Plan with superpowers, activate Expo + RN skills, write multiple plan files. Create a
  worktree of the current commit `feat/dev-dashboard-mobile`. → D2, D23, D26.

### 2026-05-29 — Architecture forks answered
- Connection: "lan + tunnel but support tailscale/vpn too… abstract this… commercial product…
  provide managed impl which sets everything up but support others, make it extensible… maybe create
  dev-dashboard-server… even a landing page… use high design skills." → D1, D4, D5, D6, D7, D9, D24.
- Terminal: "/research … 3 agents … document in DevDashboard/research/ … swappable … native xterm an
  option … present options, pick if high confidence." → D12, D13, D25.
- v1 scope: "full parity phased, all plans ready, implement metrics + cmux + tmux + qa first, obsidian
  too; strong foundation + refactors first." → D23.
- Refactor depth: "Extract backend service." → D4.

### 2026-05-29 — Stack steer
- "use zustand if needed and tanstack query / other tanstack if applicable, ofc expo- libs where
  possible. if choosing libs tell me ask me." → D16, D17, D20.
- "high end visual design is top!" → D24.

### 2026-05-29 — Library decisions (AskUserQuestion answers)
- Terminal: "prepare both [WebViews] + add an option to switch driver in-app, both should work …
  research more (termix/terminal#/terminus/open source) … 2 agents min … the researched one can be a
  3rd driver." → D12, D13.
- Theming: "nativewind v5 (look research release notes and high/bad issues, be prepared) … plan must
  know how to search docs on demand … appium tests + page objects + spec so you can iterate." → D15,
  D21, D22.
- Charts: "victory-native XL." → D14.
- Trust tier: "1 + 2" (Tailscale-trust-max+LAN AND managed-CF-with-E2E). → D7, D9.

### 2026-05-29 — Storage + cloudflared friction
- "expo-sqlite/kv-store or mmkv? i think expo … use sqlite elsewhere too." → D19 (Expo-SQLite KV +
  relational; drop MMKV).
- "offer their own cloudflared setup but with guide and maximum effort to be without friction for non
  technical vibecoders." → D8 (guided self-hosted cloudflared wizard).

### 2026-05-29 — Persistence + managed domain
- "document all decisions to a file you will always read even after compaction." → THIS FILE created;
  memory points here.
- "offer another option — cloudflared in a way we manage the (sub)domains if they don't have their?
  optional." → D10 (optional managed-(sub)domain cloudflared variant).

### 2026-05-29 — Design delivery + audience/roadmap
- Design: "make me all 3, i will decide later based on that." → D27 (build all three landing
  directions as real artifacts; choose from the builds).
- Audience/roadmap: "main target is agent developers, vibecoders, etc … but not only them — think of
  more targetable audience and features that can be on the roadmap to make this top shelf product."
  → D28 (broaden audience + a roadmap → `DevDashboard/PRODUCT-ROADMAP.md`).

### 2026-05-29 — E2E crypto lib locked
- "e2e crypto — the twitter one is by x? if so use it.. or just make sure you pick the more mature
  more starred more maintained on gh." → D29. Clarified the name is unrelated to Twitter/X (TweetNaCl
  = DJB's NaCl small enough to fit in 100 tweets). GitHub check: `tweetnacl-js` **1,923★** (pure JS,
  public domain, last push 2025-08) vs `react-native-libsodium` 56★ (native, needs prebuild) vs
  `react-native-sodium` 59★ (stale, 2022). Picked **`tweetnacl`** — wins on stars/maturity AND is
  pure-JS (no native build, runs in Expo Go). Unblocks Plan 02 (Transport/Trust).

### 2026-05-29 — Import aliasing convention
- "important detail all plans should have — do not use relative imports `../` etc, everything aliased!
  dev-dashboard common stuff for mobile can have `@dd/` for example." → D30. No relative imports
  project-wide; mobile uses `@/*` (intra-app) + `@dd/*` (→ `src/dev-dashboard/*`, e.g. `@dd/contract`);
  repo/Agent stays `@app/*`. Wire aliases in tsconfig `paths` AND Metro/Babel resolver. Plan-04 agent
  notified mid-build to apply + retrofit. Plan 02 Agent-side files already comply.

### 2026-05-29 — Mobile import convention locked (during plan 04 impl)
- "pls no relative imports all as alias instead of ../../" → then formalized: "NO relative imports
  anywhere (`../`, `./`). Everything must be path-aliased. `@/*` → `DevDashboard/mobile/src/*`;
  `@dd/*` → `src/dev-dashboard/*` (e.g. `@dd/contract`). Wire in BOTH tsconfig paths AND the
  Metro/Babel resolver so it resolves at bundle time." → D30. Implemented during plan 04: replaced the
  plan's `@app-mobile/*`/`@devdashboard/contract` aliases with `@/`/`@dd/contract`; used Metro
  `resolver.resolveRequest` (Expo-recommended) for bundle-time resolution rather than
  `babel-plugin-module-resolver`. `@app/utils/json`→shim + `@app/*`→repo `src/` kept only for the
  contract's own internal re-exports.

### 2026-05-30 — Mobile data-fetching architecture
- "components should never do raw useQuery() right? better a hook which returns useQuery? what is
  standard? research gh_grep of OSS expo/rn apps." → D32. gh_grep confirmed: custom-hook-per-endpoint +
  centralized query-key factory is universal (incl. the kortix-ai/suna Expo mobile app); TanStack v5
  `queryOptions` factories are the modern reuse-everywhere refinement (Uniswap, Prefect, pangolin,
  TanStack's own e2e). Our shape: `queryOptions` factories over the `@dd/contract` client + thin `use*`
  hooks; swap mock↔real at the client/provider, NOT the hooks. Building the data-layer foundation + a
  Pulse reference screen now.

### 2026-05-30 — Feature fan-out + Cloud product + overnight autonomy
- "do all other screens in parallel… as soon as mock api + hooks complete." → after the data-layer
  foundation + Pulse landed (`10981acc5`), fanned out 4 parallel isolated-worktree agents (Plans 06–09)
  + an Appium-foundation agent. Each consumes the frozen foundation + per-feature folders.
- "landing + auth/customer dashboard… everything done when I wake up." → D33–D36. Launched a Cloud build
  agent (DevDashboard/cloud/web, DashboardApp/Vite/TanStack-Router stack, obsidian landing, Better-Auth+
  SQLite pluggable, real-but-env-gated provisioning+Stripe, playwright-verified).
- "schedule local wakeups every 30 min for 3.5h asking if everything is done/committed/pushed/PR-reviewed."
  → 7 one-shot CronCreate jobs (01:43–04:43, session-only) firing the autonomous check-and-continue prompt.
- ⚠️ **OPEN: D35 WorkOS-vs-Better-Auth ambiguity — confirm with user.**

### 2026-05-31 — D37/D38 (mobile design + reachability)
- **D37:** User reviewed the running sim app and flagged the Connect screen as ugly/plain — it ignores the
  Obsidian Terminal design system we authored (`.claude/docs/obsidian-design-system.md`, main repo). All mobile
  screens must adopt it; Connect is the pilot restyle. The `dd-*` NativeWind tokens likely need enriching to
  carry the aesthetic (double-bezel cards, emerald/violet accents, Clash Display/General Sans/Satoshi, grain/orbs).
- **D38:** Root-caused the sim "Unreachable" on LAN connect: dev-dashboard agents bind IPv4-only (`*:3042`),
  the iOS sim resolves `localhost`→IPv6 `::1`, so `expo/fetch` to `localhost:3042` hits nothing (no CFNetwork
  log). Confirmed: `curl -4 127.0.0.1:3042/api/system/pulse`=200, `curl -6 [::1]:3042`=000. Fix = normalize
  `localhost`→`127.0.0.1` in the LAN connect/probe path (also a real-world robustness fix).

<!-- Append new decisions below this line as the user makes them. Never rewrite entries above. -->
