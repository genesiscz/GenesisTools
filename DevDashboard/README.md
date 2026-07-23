# DevDashboard

> **Commercial product:** a mobile app that streams your dev **machine** to your **phone** — live
> terminals (tmux/cmux/ttyd), system **Pulse** metrics, QA/agent signals, Obsidian, Claude usage,
> daemon runs, containers — over a **privacy-first, trust-verifiable** transport. Built on the
> existing `src/dev-dashboard/` web dashboard.
>
> **Branch:** `feat/dev-dashboard-mobile` (worktree). **Start here, then read `DECISIONS.md` + the ADR.**

## ⚠️ Read order (especially after a new session / compaction)

1. **`DECISIONS.md`** — canonical, user-maintained decision log (always read first).
2. **`.claude/plans/2026-05-29-DevDashboardMobile-ADR.md`** — frozen cross-cutting decisions + interfaces.
3. **`.claude/plans/2026-05-29-DevDashboardMobile-00-Overview.md`** — program spine + phasing + plan index.

## Artifact map

```
DevDashboard/
  README.md            ← you are here (product hub)
  DECISIONS.md         ← canonical decision log (always read first)
  PRODUCT-ROADMAP.md   ← expanded audiences + feature roadmap + monetization + positioning
  research/            ← 11 verified research reports (00 baseline → 10 terminal synthesis)
  cloud/landing/       ← 3 landing-page directions to choose from (obsidian-terminal / field-notes / daylight)
  mobile/              ← the Expo SDK 55 app (scaffolded by plan 04)
DevDashboard/plans/    ← the 13 implementation plans (ADR + 00–11), committed for durability
.claude/plans/2026-05-29-DevDashboardMobile-*.md   ← same plans, local working copies (gitignored)
src/dev-dashboard/     ← the DevDashboard Agent (extracted backend) + contract + existing web UI
```

## The four artifacts (naming — avoid "server" ambiguity)

- **DevDashboard Agent** — on-device server (`src/dev-dashboard/`, `tools dev-dashboard agent`).
- **DevDashboard Mobile** — the Expo app (`DevDashboard/mobile/`).
- **DevDashboard Web** — the existing React UI (`src/dev-dashboard/ui/`), re-pointed at the contract.
- **DevDashboard Cloud** — managed tier: landing + signup + provisioning (`DevDashboard/cloud/`).
- **`@devdashboard/contract`** — shared DTOs + endpoint catalog + typed client (web + mobile + agent).

## Trust tiers (the product's core promise)

"Your machine. Your keys. We can't see your data — and you can prove it." Behind one `Transport` interface:
- **LAN / mDNS** — same Wi-Fi, zero third party.
- **Tailscale / WireGuard** — trust-max default (E2E; nobody in the middle).
- **Self-hosted Cloudflare tunnel** — guided one-command wizard, *your* CF account (vendor never in path).
- **Managed** (one-tap remote) — honest no-see **only via app-layer E2E** (keys only on phone + Mac).
- **Managed (sub)domain** (optional) — vendor provides `<name>.devdashboard.app` for users without a domain (inherits the managed E2E requirement when vendor-fronted).

## Implementation plans (13)

| # | Plan | Phase |
|---|------|-------|
| 00 | Overview (program spine) | — |
| ADR | Architecture Decision Record | — |
| 01 | Server Extraction (Agent registry) | Foundation |
| 03 | Shared Contract (`@devdashboard/contract`) | Foundation |
| 02 | Transport & Trust (4 tiers + E2E) | Foundation |
| 04 | Mobile Foundation (Expo scaffold + Appium harness) | Foundation |
| 05 | Feature: Pulse metrics | v1 |
| 06 | Feature: Terminals (tmux/cmux/ttyd, 2 drivers + switcher) | v1 |
| 07 | Feature: QA live stream | v1 |
| 08 | Feature: Obsidian | v1 |
| 09 | Remaining features (todos/claude-usage/daemon/containers/weather) | v2 |
| 10 | Landing + Managed (Cloud) | v2 |
| 11 | Distribution (EAS, agent packaging) | v2 |

**Build order:** 01 → 03 → 02 → 04 → (05, 06, 07, 08) → 09 → 10 → 11. Appium specs gate every feature.

## Key resolved decisions (see DECISIONS.md for all)

- **Expo SDK 55** (New Arch mandatory). **Zustand** + **TanStack Query v5** + **expo-router native tabs**.
- **Storage:** `expo-sqlite/kv-store` + `expo-sqlite` + `expo-secure-store` (MMKV dropped).
- **Charts:** victory-native XL (Skia). **Theming:** NativeWind v4.2.4 now → v5 later.
- **Terminal:** 2 WebView drivers (ttyd-URL + local-xterm/WS) + in-app switcher; no 3rd driver
  (native SwiftTerm deferred). RNW #3880 patch for the iOS New-Arch bug.
- **SSE** via `expo/fetch`; **WS** via `partysocket`. **E2E** via a `BoxCipher` interface (tweetnacl
  proposed, react-native-libsodium fallback — pending user confirm + Hermes benchmark).

## Status (2026-05-29)

Planning + research complete: 13 plans, ADR, DECISIONS, 11 research reports. 3 landing directions +
the product roadmap in progress. **Next:** user picks the landing direction from the built pages;
implementation starts with the foundation (01 → 03 → 02 → 04).
