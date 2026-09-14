# DevDashboard Mobile + Product — Program Overview (Master Plan)

> **For agentic workers:** This is the **program spine**, not a task-level plan. Each subsystem
> has its own detailed plan file (see the Plan Index). Implement subsystem plans with
> `superpowers:subagent-driven-development`. Cross-cutting decisions are frozen in the **ADR**
> (`2026-05-29-DevDashboardMobile-ADR.md`) — read it before any subsystem plan.

**Goal:** Turn the personal `dev-dashboard` web app into (1) a beautiful **Expo SDK 55 React
Native** mobile client at full feature parity, and (2) a **commercial, trust-verifiable product**:
a standalone on-device agent, a pluggable transport, and an optional managed cloud + landing page.

**Architecture (3 + 1 artifacts — named to avoid the "server" ambiguity):**

1. **DevDashboard Agent** (`dev-dashboard-agent`) — the on-device server **extracted** from
   `src/dev-dashboard/ui/vite-middleware.ts`. Runs on the user's/customer's machine, exposes the
   `/api/*` contract + ttyd terminals over the chosen transport. macOS today; platform-abstracted
   for Linux/Windows later.
2. **DevDashboard Mobile** (`dev-dashboard-mobile`) — the Expo SDK 55 app (the client).
3. **DevDashboard Web** — the existing React UI, kept; re-pointed at the Agent via the shared
   contract (no rewrite).
4. **DevDashboard Cloud** (`dev-dashboard-cloud`, *managed tier, optional*) — vendor-side landing
   page, signup, managed tunnel provisioning, account/billing. Built with `high-end-visual-design`.

**Tech Stack:** Bun + TypeScript (Agent, shared contract), Expo SDK 55 / RN 0.83 / React 19.2 /
expo-router / TanStack Query (Mobile), the existing React+Vite (Web). Transport: LAN/mDNS,
Cloudflare Tunnel, Tailscale/WireGuard, managed — behind one interface. **Terminal renderer +
charting lib + SSE strategy are decided by the research workflow → frozen in the ADR.**

---

## Why this shape

- The existing handlers are already thin controllers over `lib/<feature>/*` (verified in
  `DevDashboard/research/00-current-architecture.md`). Extraction is a **transport refactor**, not
  a rewrite — low risk, high leverage. Web + Mobile + future clients all consume one contract.
- **Trust is the product.** A "we can't see your data" claim cannot hold for a vendor-managed
  Cloudflare-style tunnel (TLS terminates at the vendor's edge). The honest model is **tiered**:
  - **Trust-max** (default): self-host / **Tailscale** (WireGuard E2E — relay sees only ciphertext;
    vendor provably not in the data path).
  - **Managed-convenience**: vendor sets everything up, but the no-see claim only survives with
    **E2E encryption above the transport**. The ADR + transport plan confront this directly.
- **Swappability everywhere it's risky:** the terminal renderer and the transport are both behind
  interfaces, so a failed approach is replaced without touching feature code.

```
 ┌─────────────────┐         transport (pluggable)         ┌──────────────────────┐
 │ DevDashboard     │  LAN / Cloudflare / Tailscale / mgd  │  DevDashboard Agent   │
 │ Mobile (Expo 55) │ ───────────────────────────────────▶│  (Bun) on the machine │
 │  + Web (React)   │   /api/* JSON  ·  /api/qa/stream SSE  │  /api handlers        │
 └─────────────────┘   ·  ttyd WebSocket (terminals)        │  lib/* (unchanged)    │
        ▲                                                    │  SystemCollector      │
        │ optional managed signup/provisioning               │  ttyd / tmux / cmux   │
   ┌────┴───────────────┐                                    └──────────────────────┘
   │ DevDashboard Cloud │  landing + account + managed tunnel (high-end-visual-design)
   └────────────────────┘
```

## Locked decisions (from the user, 2026-05-29)

- **Product**, not just a personal clone. Trust/verifiability first-class.
- **Transport is abstracted/pluggable**: LAN + tunnel + Tailscale/VPN + managed, one interface.
- **Extract the backend service** (the Agent) — chosen over keeping it inside Vite.
- **Expo SDK 55** confirmed GA (Feb 2026, RN 0.83, React 19.2). **Legacy Architecture removed →
  New Architecture mandatory** (hard gate on every native lib).
- **v1 implementation order**: foundation + refactors first → then **Pulse/metrics, tmux, cmux,
  QA, Obsidian**. All 9 features are *planned*; deferred ones (claude-usage, daemon, containers,
  weather) ship after.
- **Landing/managed design**: `high-end-visual-design` skill (the user's pick).
- **Terminal renderer + design direction**: user will *choose* from researched options.

## Phasing (each phase = working, testable software)

- **Phase 0 — Foundation refactor (Agent + Contract).** Extract `dev-dashboard-agent` with a
  transport-agnostic handler registry; lift `lib/*` untouched; carve out `@app/dev-dashboard/
  contract` (types + endpoint paths + a typed client) consumed by Web + Mobile. Web keeps working.
  Plans: 01-ServerExtraction, 03-SharedContract.
- **Phase 1 — Transport + trust.** Pluggable transport interface + LAN/mDNS + Tailscale +
  Cloudflare adapters; connection/pairing UX; the tiered trust model + E2E-for-managed design.
  Plan: 02-TransportTrust.
- **Phase 2 — Mobile foundation.** Expo SDK 55 app scaffold: expo-router nav (native tabs),
  theming, TanStack Query data layer, secure auth/connection store, SSE client, error/empty states,
  design system port. Plan: 04-MobileFoundation.
- **Phase 3 — First features (parity):** Pulse/metrics → tmux → cmux → QA (SSE) → Obsidian.
  Plans: 05-FeaturePulse, 06-FeatureTerminals (tmux+cmux+ttyd), 07-FeatureQA, 08-FeatureObsidian.
- **Phase 4 — Remaining features:** claude-usage, daemon, containers, weather. Plan: 09-FeaturesRest.
- **Phase 5 — Product surface:** landing page + managed dashboard + provisioning. Plan:
  10-LandingAndManaged.
- **Phase 6 — Distribution:** EAS dev-client / build / TestFlight / store, OTA updates, agent
  packaging/install. Plan: 11-Distribution.

## Plan Index (status)

| # | Plan file | Subsystem | Depends on | Status |
|---|-----------|-----------|------------|--------|
| 00 | `…-00-Overview.md` | Program spine | — | ✅ this file |
| — | `…-ADR.md` | Cross-cutting decisions | research | ⏳ after research |
| 01 | `…-01-ServerExtraction.md` | Agent extraction | ADR | ⏳ |
| 02 | `…-02-TransportTrust.md` | Pluggable transport + trust | ADR, 01 | ⏳ |
| 03 | `…-03-SharedContract.md` | `@app/dev-dashboard/contract` | ADR, 01 | ⏳ |
| 04 | `…-04-MobileFoundation.md` | Expo 55 app scaffold | ADR, 03 | ⏳ |
| 05 | `…-05-FeaturePulse.md` | Pulse metrics + charts | 04, ADR | ⏳ |
| 06 | `…-06-FeatureTerminals.md` | tmux/cmux/ttyd (renderer) | 04, 02, ADR | ⏳ |
| 07 | `…-07-FeatureQA.md` | QA live SSE | 04, ADR | ⏳ |
| 08 | `…-08-FeatureObsidian.md` | Obsidian browse/read | 04 | ⏳ |
| 09 | `…-09-FeaturesRest.md` | claude-usage/daemon/containers/weather/todos | 04 | ⏳ |
| 10 | `…-10-LandingAndManaged.md` | Cloud landing + managed | 02 | ⏳ |
| 11 | `…-11-Distribution.md` | EAS + agent packaging | 04, 01 | ⏳ |

## Milestones / definition of done per phase

- **M0:** `tools dev-dashboard` still serves the web UI, but routes are now driven by the extracted
  registry; `dev-dashboard-agent` can also serve `/api` standalone (no Vite). Web UI imports types
  from the contract package. All existing dev-dashboard tests green.
- **M1:** Mobile app on a real iPhone connects to the Mac over LAN AND Tailscale, authenticates, and
  shows live Pulse metrics updating ~1 Hz.
- **M2:** tmux + cmux lists + an interactive ttyd terminal work on device (chosen renderer).
- **M3:** QA live stream + Obsidian reader at parity.
- **M4:** Landing page live; managed signup provisions a tunnel for a test account.

## Top risks (tracked; mitigations in sub-plans)

1. **Terminal on RN** is the highest-risk piece (RN terminal libs are a graveyard). → research +
   swappable `TerminalRenderer` interface; WebView-ttyd as the low-risk default.
2. **SSE on RN New Arch** — fetch streaming support uncertain. → research file 04 picks the client;
   fallback is a polyfilled EventSource or WS-bridged events.
3. **Trust claim vs managed tunnel** — reputational if mis-stated. → tiered model + E2E-above-
   transport; marketing copy reviewed against the architecture.
4. **macOS-only collector + ttyd/cmux** — won't run on customer Linux boxes. → `SystemCollector`
   interface + capability advertisement; v1 targets macOS, product roadmap adds Linux.
5. **Scope** — this is a multi-month program. → strict phasing; v1 = foundation + 5 features.

## How to use this plan set

1. Read this file + the **ADR**.
2. Pick the subsystem plan for your phase.
3. Implement task-by-task with `subagent-driven-development`; commit per task.
4. The user explicitly chooses: **terminal renderer** (after research) and **landing-page design
   direction** (high-end-visual-design mockups).
