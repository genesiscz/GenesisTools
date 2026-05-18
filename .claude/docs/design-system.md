# Design System — Shared UI Contract

> Why clarity/shops drifted "flat" while dashboard/dev-dashboard look good,
> and the rules that keep every GenesisTools UI consistent. Read this BEFORE
> writing or restyling any web UI under `src/<tool>/ui` or `src/dashboard`.

## Context Triggers

<context_trigger keywords="ui,frontend,component,styling,css,tailwind,shadcn,theme,card,button,badge,login,dashboard,restyle,design">
**Load:** this file, src/utils/ui/theme/styles.css, src/utils/ui/theme/wow-components.css
**Files:** src/utils/ui/components/, src/utils/ui/theme/, src/utils/ui/custom/
**Quick:** One shared system: tokens in `@ui/theme/styles.css`, primitives in
`@ui/components/*`, opinionated looks in `wow-components.css` + `@ui/custom/*`.
Consume it; never repaint it with raw `zinc-*`/`white/*` utilities. Wrap
routes in a shell. Pick a rich Card/Button variant explicitly.
</context_trigger>

<context_trigger keywords="flat,ugly,looks bad,inconsistent,drift,not pretty,bland,washed out">
**Load:** this file (§ Root Causes, § The Rules)
**Quick:** "Flat" = one of: (1) raw `bg-zinc-*`/`border-white/*` overriding the
themed Card surface, (2) `<Button>`/`<Card>` left at the flat resolved
`default` variant, (3) no `<AppShell>`/`<AuthLayout>` so content floats on bare
`--background`. Fix the component/composition, not the palette.
</context_trigger>

---

## The One Principle

**There is exactly one design system. It already ships everything you need.
Your job is to *consume* it, not re-skin it.**

- **Tokens:** `@ui/theme/styles.css` — oklch palette + `.wow` / `.cyberpunk`
  themes + `gradient-text` / `neon-glow` / animations. Imported by clarity,
  shops, dev-dashboard. The dashboard inlines a byte-identical copy.
- **Primitives:** `@ui/components/*` — shadcn (Radix + CVA): Card, Button,
  Badge, Input, Dialog, Table, …
- **Opinionated looks:** `@ui/theme/wow-components.css` + `@ui/custom/*` —
  `feature-card`, `wow-glow-hover`, `glass-card`, `stat-card`, `glow-orb`,
  `nav-blur`, `section-label`, `tag-*`, `icon-container-*`.

The tokens are **not** the drift. clarity/shops import the *same* tokens the
"WOW" dashboard uses. They look flat because of how they *consume* the system.

Evidence (2026-05-18 sweep): `.claude/docs/assets/ui-drift-2026-05-18/`.
The dashboard's **empty** Timer/Tasks pages (11, 12) are more polished than
clarity's/shops' **full** pages (01, 05) — a pure composition gap.

---

## Root Causes of the Drift (do not reintroduce)

1. **Repainting the themed surface.** `Card[data-variant="default"]` inside
   `.cyberpunk` gets glass + amber-glow from shared CSS
   (`rgba(10,10,20,.9)` + `backdrop-filter: blur(20px)` + amber border +
   inset/outer glow). clarity/shops override it with
   `className="bg-zinc-950 border-zinc-800"` / `border-white/5` — raw
   utilities that **kill the transparency, blur, and amber border**.
   → **122 raw-palette utilities across 38 files** in clarity+shops.
2. **Flat resolved variant.** Theme provider default is `"default"`
   (`@ui/theme/provider`), so a bare `<Button>` resolves to `bg-primary`
   flat fill (no shadow/glow) and a bare `<Badge>` to the hollow `cyber`
   outline. The rich `cyber`/`brand`/`wow` looks exist but are never the
   resolved default.
3. **No shell / ambient layer.** dashboard wraps routes in `AuthLayout`
   (grid bg + radial glow + branded chrome). clarity/shops render bare
   content on flat `--background` in a void — no texture, no chrome, no
   density.
4. **Polish = composition, and it isn't shared.** The dashboard's "WOW" is
   *not* the shared `wow-components.css` — it doesn't even import it
   (several `feature-card` refs there are inert). It comes from
   **composition**: `AuthLayout` + heavy inline Tailwind + local
   `components/auth/cyberpunk.css` (`glass-card`, `gradient-text`) + the
   inlined tokens + `tw-animate-css`. clarity/shops *have* the shared
   `wow-components.css` (via `@ui/theme`) but use none of it, add no
   composition, and repaint with zinc. dev-dashboard looks good only via a
   *third* private system (`--dd-*` + `dd-grid-bg` + `dd-panel`). Polish
   scales with per-app effort, not the shared layer — Phase 2 fixes that
   by lifting the shell/auth composition into `src/utils/ui`.

---

## The Rules

### DO

- **Use theme tokens for every color.** `bg-card`, `bg-background`,
  `bg-muted`, `text-foreground`, `text-muted-foreground`, `border-border`,
  `text-primary`, `bg-primary`, `text-destructive`. These follow the active
  theme automatically.
- **Render `<Card>` without overriding its surface.** Let the themed
  `data-variant` CSS apply. For metric/feature tiles use
  `<Card variant="wow-static">` or `<Card variant="wow">` (hover glow),
  or the `feature-card` / `stat-card` utility classes.
- **Pick a Button variant on purpose.** Primary CTA → `variant="brand"`
  (purple, shadow, hover-lift) or the theme's `cyber`. Reserve plain
  `default` for low-emphasis only.
- **Wrap every route tree in a shell.** A page must sit on the ambient
  background (grid + optional radial glow) inside a consistent
  header/sidebar — never floating on bare `--background`.
- **Wrap every auth page in the shared auth layout** (branded logo +
  glass card + ambient bg). Login/register must look like the product.
- **Add depth via the shared utilities:** `wow-glow-hover`,
  `theme-glow-hover`, `glass-card`, `nav-blur`, `gradient-text`,
  `section-label`, `icon-container-<color>`, `tag-<color>`.
- **Fill empty states** with an `icon-container` + glow, heading,
  description, and a saturated primary CTA (copy the dashboard pattern).

### DO NOT

- **No raw Tailwind palette in app code.** Never `bg-zinc-*`,
  `border-zinc-*`, `bg-neutral-*`, `text-zinc-*`, `border-white/NN`,
  `bg-white/NN`, `bg-black/NN` for surfaces/borders/text. They bypass the
  theme and flatten themed components. (Opacity tints of *token* colors —
  `bg-primary/10`, `border-primary/30` — are fine.)
  **Scope:** this ban is for **app code** (`src/<tool>/ui`,
  `src/dashboard/.../routes`). Shared primitives/variants in
  `src/utils/ui/*` MAY hardcode palette inside a variant
  (e.g. `buttonVariants.brand` = `bg-purple-600`) — that is the system
  *defining* a look, not an app *bypassing* it.
- **Never override a Card's `bg-*`/`border-*`** unless using
  `variant="plain"` deliberately.
- **Never hand-roll a login/auth screen, app header, or sidebar** per app —
  use the shared shell/auth-layout.
- **Don't fork a private theme** (`--dd-*`-style) for a new tool without
  agreement. dev-dashboard's divergence is grandfathered, not a precedent.
- **Don't ship a UI without a frontend-design pass** (skill + this doc).

---

## Component Variant Cheat-Sheet

- **Card:** `default` (theme-aware glass/glow — preferred), `wow`
  (gradient border + hover glow), `wow-static` (gradient bg, no hover —
  metrics), `cyber` (neon glass), `plain` (flat — opt-in only).
- **Button:** `brand` (purple hero CTA), `cyber` (neon glass, theme),
  `default` (flat `bg-primary` — low-emphasis), `outline`/`ghost`/`link`,
  `destructive`.
- **Badge:** `default` (solid primary), `secondary`, `destructive`,
  `cyber`/`cyber-secondary` (glass outline — status pills),
  `outline` (text only).
- **Surfaces/effects:** `glass-card`, `feature-card`, `stat-card`,
  `wow-glow` / `wow-glow-hover` (set `data-accent` for color),
  `theme-glow-hover`, `nav-blur`, `glow-orb`, `gradient-text`,
  `section-label[-color]`, `tag-<color>`, `icon-container-<color>`.

## Pre-Ship Checklist

- [ ] `bun run check:ui-palette` → exits 0 (the guardrail; see below)
- [ ] Every page sits inside the app shell on the ambient background
- [ ] Auth pages use the shared auth layout (branded, glass, ambient)
- [ ] Primary CTAs use `brand`/`cyber`, not flat `default`
- [ ] Cards use a rich variant or unmodified themed `default`
- [ ] Empty states have icon + glow + heading + CTA (not bare text)
- [ ] Screenshot it next to a dashboard page — same visual family?

---

## Canonical Shells (use one — never hand-roll)

The drift was fixed at the root (2026-05-18). Every new dashboard/tool UI MUST
consume one of these; they wire `ThemeProvider variant="nexus"` + `cyber-grid`
ambient bg + glow orbs + glass header automatically, so consumers get the
design system "for free" with no per-app theme code:

- **`@ui/layouts/DashboardLayout`** — top-nav apps (clarity, shops, reas).
  Pass `title`, `navLinks`, `activePath`, `onNavigate`, optional `rightSlot`.
  Set `<html className="cyberpunk">` in the root document.
- **`@ui/custom/AppShell`** — sidebar apps (the dashboard). Sidebar + nexus.
- **`@ui/layouts/AuthLayout`** — every login/register screen. Props:
  `brand`, `icon`, `footer`. Branded glass card on ambient bg.
- **`@ui/custom/*`** — compose pages from `FeatureCard`, `EmptyState`,
  `GlowOrbs`, `HeroBanner`, `StatCard`, `SectionLabel`, `IconContainer`,
  `Tag` — never hand-roll these.

## Guardrail (enforced)

`bun run check:ui-palette` (`scripts/check-ui-palette.ts`) — **hard-fails** on
raw `zinc`/`neutral`/`white-opacity` surfaces/text under `src/{clarity,shops}/ui`,
`src/Internal/commands/reas/ui`, `src/dev-dashboard/ui/src`. A deliberate
semantic carve-out (categorical status colors, media scrims) must carry an
inline `// allow-palette: <reason>` (or `scrim`/`overlay`) comment **on the
same line**. Wire it into CI alongside `lint`.

## New-Dashboard Checklist

1. Root document: `<html className="cyberpunk">`.
2. Wrap routes in `@ui/layouts/DashboardLayout` (or `AppShell`).
3. Auth (if any) in `@ui/layouts/AuthLayout`.
4. Compose pages from `@ui/components/*` + `@ui/custom/*` only.
5. Colors = theme tokens (`bg-card`, `border-border`, `text-muted-foreground`,
   `text-primary`…). Zero raw palette.
6. `bun run check:ui-palette` green + screenshot beside a dashboard page.

> Per-dashboard design lineage (which shell/theme each of the 8 dashboards
> uses, why youtube/dev-dashboard diverge, the differ-matrix) →
> `.claude/docs/design-system-dashboards.md`. Ports/launch/conflict-detection
> → `src/utils/ui/dashboards.ts`.

## Deferred Follow-up

~679 `text-gray-*` / `text-slate-*` / `bg-slate-*` occurrences remain across
clarity/shops/reas (same pathology, lower visual impact than the fixed
zinc-surface drift). The guardrail **warns** (not fails) on these. Next pass:
`text-gray-{400,500,600}`→`text-muted-foreground`, `{100,200,300}`→
`text-foreground`, `bg-slate-9xx`→`bg-card`. Deliberate slate hero panels /
radial-gradient backdrops in `reas/.../AnalysisSections` are intentional —
keep, tagged.
