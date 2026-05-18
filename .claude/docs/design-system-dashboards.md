# Dashboards — Design-System Catalog

> Every web dashboard in this repo, categorized by *how* it relates to the
> shared UI system. Companion to `design-system.md` (the shared-UI contract)
> and `src/utils/ui/dashboards.ts` (the machine-readable registry: ports,
> launch commands, auth — the **source of truth for ports**, do not duplicate
> port numbers here).

## Context Triggers

<context_trigger keywords="dashboard,dashboards,which dashboard,new dashboard,port,3071,3072,3073,3074,3042,3069,3000,youtube ui,dev-dashboard,clarity ui,shops ui,reas dashboard,design system,differ,registry">
**Load:** this file, `src/utils/ui/dashboards.ts`, `.claude/docs/design-system.md`
**Quick:** 8 dashboards in 4 design families. Ports/launch live in
`@ui/dashboards` (`DASHBOARDS`, `findPortConflicts()`). Shared-UI rules for
families A/B are in `design-system.md`. youtube/dev-dashboard are deliberate
divergences (documented below) — not precedents.
</context_trigger>

<context_trigger keywords="youtube design,yt ui,youtube dashboard,why youtube,bespoke shell,sidebar app">
**Load:** this file (§ Family C — youtube)
**Quick:** youtube has its OWN `Sidebar`+`Topbar` shell (not
`DashboardLayout`/`AppShell`) but **correctly consumes** the shared theme
(`.cyberpunk` + `@ui/theme/styles.css` + cyber-grid/scan-lines) and shared
`@ui/components/*`. It was never flat-drifted because it consumed the system
correctly — `before ≈ after` in the evidence gallery is *expected*. Needs a
separate API server (`tools youtube server start`, :9876).
</context_trigger>

---

## The One System, Consumed N Ways

There is exactly **one** design system (`design-system.md`): tokens in
`@ui/theme/styles.css`, primitives in `@ui/components/*`, opinionated looks in
`wow-components.css` + `@ui/custom/*`. Dashboards differ only in **how much of
it they consume** and **which shell they wrap routes in**. The 2026-05-18
flat-drift was *misuse* of this system by clarity/shops/reas (raw `zinc/white`
repainting the themed surface), not a flaw in it — see `design-system.md`
§ Root Causes.

Ports, launch commands, tech and auth for all of these are defined once in
`src/utils/ui/dashboards.ts` (`DASHBOARDS`). `findPortConflicts()` guards
uniqueness — wire it into a test/launcher when adding a dashboard.

---

## Family A — Shared shell, top-nav (the governed set)

**clarity · shops · reas**

- **Shell:** `@ui/layouts/DashboardLayout` (top nav). Root document
  `<html className="cyberpunk">`.
- **Theme:** shared `@ui/theme/styles.css`, `ThemeProvider variant="nexus"`,
  cyber-grid + glow orbs + glass header (wired by the layout — free for
  consumers).
- **Primitives:** shared `@ui/components/*` only.
- **Drift status:** these were the flat-drift victims; **fixed 2026-05-18**
  (un-flatten + de-zinc). Fully governed by `design-system.md`; the palette
  guardrail (`bun run check:ui-palette`) enforces it.
- **Evidence:** `assets/ui-drift-2026-05-18/{clarity-*,shops-*,reas-*}.png`
  / `.after.png` — dramatic before→after (this is what the fix changed).

## Family B — Shared shell, sidebar (the reference)

**dashboard** (the main personal dashboard)

- **Shell:** `@ui/custom/AppShell` (sidebar). TanStack Start + Nitro.
- **Theme:** byte-identical inlined copy of the shared tokens + local
  `components/auth/cyberpunk.css` + heavy WOW composition. This is the
  "WOW reference" quality every other app is measured against.
- **Auth:** WorkOS (no dev bypass).
- **Drift status:** never drifted — it *is* the reference. Self-contained
  subproject: own tsconfig (maps only `@ui`, no `@app`), own biome
  (`lint:dashboard`), own vite. **Do not** alias-rewrite or restyle it
  without working inside `src/dashboard/apps/web` conventions.

## Family C — Bespoke shell, correct shared-theme consumer

**youtube**

- **Shell:** its **own** `@app/yt/components/shared/{Sidebar,Topbar}` —
  *not* `DashboardLayout`, *not* `AppShell`. Root:
  `<div className="cyberpunk … bg-background/95 text-foreground">` +
  `cyber-grid` + `scan-lines`.
- **Theme:** correctly consumes the shared system —
  `styles.css` does `@import "@ui/theme/styles.css"` (plus a small own
  `:root`), uses the `.cyberpunk` class and theme tokens (`bg-background`,
  `text-foreground`), no raw `zinc/white` repaint.
- **Primitives:** heavily uses shared `@ui/components/*` (card, button,
  badge, dialog, table, skeleton, select, …) **and** YouTube-specific
  shared components that live in the shared dir
  (`@ui/components/youtube/{tabs,summary-tab,insights-tab,comments-tab,transcript-tab}`).
- **Why it didn't drift:** it was always a *correct* consumer (themed
  surfaces, tokenized colors, own shell). The un-flatten fix repaired
  clarity/shops/reas's *misuse* — youtube had nothing to fix.
  `assets/ui-drift-2026-05-18/yt-{home,jobs}.png` ≈ `.after.png` by design
  (a positive exemplar, like devdash below — *not* a capture error).
- **Runtime gotcha:** the UI (`tools youtube ui`, vite frontend) needs a
  **separate API server** — `tools youtube server start` (default :9876,
  normally a launchd daemon). Without it the UI renders but every request
  is `ERR_CONNECTION_REFUSED`. (Frontend port moved 3072→3074 on
  2026-05-18 to resolve a hard `--strictPort` clash with reas; both now
  source their port from `@ui/dashboards`.)
- **Shell debt (NOT a promote candidate):** youtube's `Sidebar`+`Topbar`
  are *not* generic components to lift into `@ui` — they're a
  **reinvention** of the already-shared, fully-parameterized
  `@ui/custom/AppShell` + `@ui/custom/AppSidebar` (which `dashboard`
  consumes correctly via `navGroups`/`activePath`/`user`/`LinkComponent`).
  Promoting them would mean rebuilding what exists. The canonical sidebar
  shell **is** `AppShell`+`AppSidebar`; youtube should *converge to it*
  (own `navGroups`) — an optional future refactor, not an inventory move.
  Component survey 2026-05-18: **nothing** in `src/youtube` or
  `src/dashboard` warrants promotion — youtube comps are domain-coupled,
  dashboard already consumes `@ui`, the residue (`RouteError`,
  `RouteSkeleton`, `AuthAlertBanner`) is too trivial to be worth the churn.

**Takeaway for new tools:** prefer `@ui/custom/AppShell`+`AppSidebar` (the
canonical sidebar shell) or `@ui/layouts/DashboardLayout` (top-nav). A
bespoke shell is tolerable *only if* you still consume `@ui/theme` +
`@ui/components` like youtube does (bespoke + correct theme = no drift;
bespoke + raw palette = the drift) — but converging on the shared shell
beats reinventing it.

## Family D — Divergent, grandfathered (NOT a precedent)

**dev-dashboard**

- **Shell/theme:** a **private** design system — `--dd-*` CSS variables +
  `dd-grid-bg` / `dd-panel`, *not* the shared `@ui/theme` tokens. Looks good
  on its own but shares nothing with families A–C.
- **Infra:** front-proxy (Bun.serve on :3042 bridges to a random-port Vite
  for WebSocket support); basic-auth.
- **Status:** explicitly **grandfathered** in `design-system.md`
  ("Don't fork a private theme … dev-dashboard's divergence is
  grandfathered, not a precedent"). `devdash-home.png` ≈ `.after.png`
  (untouched by the drift fix because it's off the shared system entirely).
  Do not replicate the `--dd-*` pattern for new tools.

## Family E — Standalone / legacy (outside the contract)

- **claude-history-dashboard** (`tools claude history dashboard`) — separate
  Vite + TanStack Start history browser, own tsconfig (`@app/@ui` → repo).
  Functional, not part of the shared-shell contract; not drift-audited
  beyond the registry. Treat as standalone.
- **debugging-master** — orphaned plain-Vite dashboard, **no CLI entry
  point**, no shared system. Legacy; tracked in `@ui/dashboards` only so its
  port (7244) participates in conflict detection.

---

## How They Differ — Matrix

| Dashboard | Family | Shell | Theme source | Shared `@ui/components` | Drifted→fixed? | Auth |
|---|---|---|---|---|---|---|
| clarity / shops / reas | A | `DashboardLayout` (top-nav) | shared `@ui/theme` + nexus | yes | **yes → fixed 2026-05-18** | none |
| dashboard | B | `AppShell` (sidebar) | inlined shared tokens + WOW | yes | no (reference) | WorkOS |
| youtube | C | own `Sidebar`+`Topbar` | shared `@ui/theme` (`.cyberpunk`) | yes (+ `youtube/*`) | no (correct consumer) | none |
| dev-dashboard | D | own | private `--dd-*` | no | no (grandfathered) | basic-auth |
| claude-history | E | own | own | partial | not audited | none |
| debugging-master | E | own | own (plain) | no | n/a (orphaned) | none |

> Port / launch / strictPort details intentionally omitted here — single
> source of truth is `src/utils/ui/dashboards.ts`.

---

## Adding a New Dashboard

1. **Register it** in `src/utils/ui/dashboards.ts` (`DASHBOARDS`) — pick a
   free port; keep `findPortConflicts()` green.
2. **Prefer Family A or B**: wrap routes in `@ui/layouts/DashboardLayout`
   (top-nav) or `@ui/custom/AppShell` (sidebar); set
   `<html className="cyberpunk">`; compose from `@ui/components/*` +
   `@ui/custom/*`. You inherit the WOW look for free.
3. **Family C is acceptable** (own shell) **only if** you still
   `@import "@ui/theme/styles.css"`, use the `.cyberpunk` class + theme
   tokens, and consume `@ui/components/*` — i.e. be youtube, not the drift.
4. **Family D is closed.** Do not fork a private `--dd-*`-style theme.
5. Run `bun run check:ui-palette` (green) and screenshot beside a Family-A/B
   page — same visual family? Follow `design-system.md` § Pre-Ship Checklist.

## Evidence

`.claude/docs/assets/ui-drift-2026-05-18/` — 11 pages × `<page>.png`
(before @ `dc4cb8b1`) / `<page>.after.png` (after @ `e7680729`).
Family A pages show the dramatic fix; `devdash-home` and `yt-{home,jobs}`
are ≈identical by design (D = off-system, C = already-correct).
