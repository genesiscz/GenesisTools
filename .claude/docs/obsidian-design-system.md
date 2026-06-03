# Obsidian Design System — the "DevDashboard" dark aesthetic

> The look you loved on the **obsidian-terminal** landing page, captured as a reusable system.
> Source of truth: `DevDashboard/cloud/landing/obsidian-terminal/index.html` (on the
> `feat/dev-dashboard-mobile` branch). This doc is the recipe to reproduce that beauty anywhere —
> a new landing page, a marketing section, a dashboard, or the Expo app's premium surfaces.
>
> **This is a distinct aesthetic** from the repo's general `.claude/docs/design-system.md` (the shadcn /
> theme-token shared-UI contract for the internal dashboards). Use *this* doc when the goal is a
> high-end, dark, "Linear/Vercel-grade" marketing or hero surface. Use the other doc for the internal
> tool dashboards.

---

## 0. How this look was produced (skills + process)

1. **`high-end-visual-design` skill** (locked as DECISIONS **D24** for this product). Invoke it BEFORE
   writing any landing/marketing UI — it carries the taste rules (restraint, concentric radii, one
   accent + one secondary, generous negative space, motion that serves hierarchy). This design is its
   output. Re-invoke it for any new surface in this family.
2. **Tailwind Play CDN** (`https://cdn.tailwindcss.com`) for the landing pages — zero build, instant
   iteration, `tailwind.config` inlined in a `<script>`. (For the **Expo app**, the same tokens live in
   NativeWind v4 — see §7. Do NOT ship the Play CDN in production app code; it's a prototyping/landing
   tool.)
3. **Fontshare** for premium typefaces (free, high quality, fast CDN) — Clash Display + General Sans +
   Satoshi. This font pairing is 60% of the "expensive" feel.
4. **Build the real artifact, then judge** (DECISIONS **D27**): all three landing directions were built
   as working HTML and compared in-browser — never chosen from descriptions.

**When asked for "this beautiful design" again:** invoke `high-end-visual-design`, then apply the tokens
(§1–2) and the signature techniques (§3). The single most important move is the **double-bezel card**
(§3.1) + the **mesh-orb / grain background** (§3.2) — those two alone create most of the depth.

---

## 1. Type system (Fontshare)

```html
<link rel="preconnect" href="https://api.fontshare.com" crossorigin />
<link href="https://api.fontshare.com/v2/css?f[]=clash-display@600,700&f[]=general-sans@400,500,600&f[]=satoshi@400,500&display=swap" rel="stylesheet" />
```

```js
fontFamily: {
  display: ['"Clash Display"', 'ui-sans-serif', 'system-ui', 'sans-serif'], // headings only
  sans:    ['"General Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],  // body / default
  satoshi: ['"Satoshi"', 'ui-sans-serif', 'system-ui', 'sans-serif'],       // optional accent
  mono:    ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', '"Cascadia Code"', 'monospace'],
}
```

Usage rules:
- **`font-display`** → all `<h1>/<h2>/<h3>`. Tight tracking: `tracking-[-0.02em]`, leading `[1.02]` on hero.
- **`font-sans`** (General Sans) → body copy, default on `<body>`.
- **`font-mono`** → terminal content, stat values, eyebrow labels, code, version tags, "last 60s" captions.
  Mono on small UPPERCASE labels (`text-[10px] uppercase tracking-[0.2em]`) is a signature tell.
- Hero scale: `text-5xl → sm:text-6xl → md:text-7xl`, `font-semibold`.

---

## 2. Color tokens

```js
colors: {
  ink: '#050505',                 // page background (near-black, not pure)
  emerald: { glow: '#10b981' },   // PRIMARY accent
  violet:  { glow: '#8b5cf6' },   // SECONDARY accent
}
```

| Role | Value | Notes |
|------|-------|-------|
| Page bg | `#050505` (`ink`) | `:root { color-scheme: dark }` + `background:#050505` on html/body |
| Card core bg | `#0a0b0d` | the inner surface of every double-bezel card |
| Deep terminal bg | `#060708`, `black/40` | nested code/terminal panes |
| Primary accent | emerald `#10b981` → `#34d399` → `#6ee7b7` → text `#ecfdf5` | live/positive/CTA |
| Secondary accent | violet `#8b5cf6` → `#a78bfa` → `#c4b5fd` | memory/secondary metrics |
| Warning | amber `#fbbf24` / `text-amber-300` | "needs input" / agent-paused |
| Text hierarchy | `zinc-50` (headings) · `zinc-300/400` (body) · `zinc-500/600` (muted/mono captions) | |
| Hairlines | `border-white/10`, `ring-white/[0.06]` | the thin structural lines |
| Glass fill | `bg-white/[0.03]` / `bg-white/[0.04]` | translucent surfaces over the mesh |
| Traffic lights | `#ff5f57` `#febc2e` `#28c840` | faux macOS window chrome |

Discipline: **one primary (emerald) + one secondary (violet)**, amber only for "attention". Everything
else is zinc + white-alpha. Never introduce a third hue casually.

---

## 3. Signature techniques (the "wow")

### 3.1 Double-bezel card (the core move)

Concentric squircles: a translucent glass **outer shell** with a tiny padding, wrapping a solid **inner
core** whose radius is `outer − padding` (so the corners stay concentric). An inset top-highlight
(`.inset-hi`) fakes a lit bevel.

```html
<div class="rounded-[2rem] border border-white/10 bg-white/[0.03] p-1.5 backdrop-blur-xl">
  <div class="inset-hi rounded-[calc(2rem-0.375rem)] bg-[#0a0b0d] p-7 ring-1 ring-white/[0.06]">
    <!-- content -->
  </div>
</div>
```

```css
.inset-hi { box-shadow: inset 0 1px 1px rgba(255,255,255,0.10); }
```

Rules: inner radius is ALWAYS `calc(outer − padding)`. Padding is `p-1.5` (0.375rem) or `p-2` (0.5rem).
Hover lift: `transition-transform duration-700 ease-silk hover:-translate-y-1.5`. Featured variant swaps
the ring to `ring-emerald-400/20` and the core to a subtle `bg-gradient-to-b from-[#0b1110] to-[#0a0b0d]`.

### 3.2 Mesh orbs + film grain background

```html
<div class="mesh" aria-hidden="true">
  <div class="orb orb-emerald" style="width:46rem;height:46rem;top:-14rem;left:-10rem;"></div>
  <div class="orb orb-violet"  style="width:42rem;height:42rem;top:30%;right:-12rem;opacity:.4;"></div>
  <div class="orb orb-emerald" style="width:34rem;height:34rem;bottom:-12rem;left:25%;opacity:.32;"></div>
</div>
<div class="grain" aria-hidden="true"></div>
```

```css
.mesh { position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
.orb  { position: absolute; border-radius: 9999px; filter: blur(120px); opacity: 0.5; will-change: transform; }
.orb-emerald { background: radial-gradient(circle at 30% 30%, #10b981, transparent 70%); }
.orb-violet  { background: radial-gradient(circle at 70% 70%, #8b5cf6, transparent 70%); }
.grain {
  position: fixed; inset: 0; z-index: 1; pointer-events: none; opacity: 0.035;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}
```

Content sits in a `relative z-10` `<main>` above these. The grain at 0.035 opacity is what kills the
"flat CSS" feel — it's barely visible but always there.

### 3.3 The "silk" easing — used on EVERYTHING

```js
transitionTimingFunction: { silk: 'cubic-bezier(0.32,0.72,0,1)' }
```

Every transition/animation uses `ease-silk` / `cubic-bezier(0.32,0.72,0,1)`. Consistent motion curve =
coherence. Durations: hovers `duration-500`, card lifts `duration-700`, reveals `850ms`.

### 3.4 Scroll-reveal (blur-up, staggered)

```css
.reveal { opacity:0; transform: translateY(28px); filter: blur(8px);
  transition: opacity 850ms cubic-bezier(0.32,0.72,0,1), transform 850ms cubic-bezier(0.32,0.72,0,1), filter 850ms cubic-bezier(0.32,0.72,0,1);
  will-change: transform, opacity; }
.reveal.in { opacity:1; transform: translateY(0); filter: blur(0); }
```

```js
const io = new IntersectionObserver((entries) => {
  entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
}, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
document.querySelectorAll('.reveal').forEach((el) => io.observe(el));
```

Stagger children with inline `style="transition-delay:60ms"` (then 120/160/220/300…).

### 3.5 Gradient text

```css
.grad-text { background: linear-gradient(110deg, #ecfdf5 0%, #6ee7b7 38%, #c4b5fd 88%);
  -webkit-background-clip: text; background-clip: text; color: transparent; }
```

Use on ONE emphasis span per heading (`<span class="grad-text">streamed to your phone</span>`).

### 3.6 Live micro-motion

- **Pulse dot**: `livepulse` keyframe expands a `box-shadow` ring (`0 0 0 0 → 8px` then fade) on a tiny
  emerald dot. The "live" tell.
- **Caret**: `blink` `steps(1)` on a thin emerald block after terminal text.
- **Sparkline draw**: SVG path with `stroke-dasharray:320; stroke-dashoffset:320; animation: dash 2.2s ease-silk forwards`,
  plus a gradient fill underneath (`<linearGradient>` 0.35→0 opacity). Stagger a second line with `animation-delay`.
- **Equalizer bars**: `grow` keyframe `scaleY(0.15)→1`, `transform-origin: bottom`, per-bar `animation-delay`.

### 3.7 Floating pill nav

```html
<header class="fixed inset-x-0 top-0 z-40 flex justify-center px-4">
  <nav class="mt-6 w-full max-w-3xl">
    <div class="flex items-center justify-between gap-4 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 pl-5 backdrop-blur-2xl shadow-[0_8px_40px_-12px_rgba(0,0,0,0.7)]">
      ...
    </div>
  </nav>
</header>
```

Links are `rounded-full px-3.5 py-1.5 hover:bg-white/[0.06]`. Primary CTA is a **light** pill
(`bg-zinc-100 text-zinc-900`) with a circular icon chip that nudges `translate-x-0.5` on hover.

### 3.8 Faux terminal pane

Window chrome row (three traffic-light dots + a mono title + a `live` chip), then a mono body with
syntax-style coloring: `text-emerald-400` prompts (`➜`/`$`), `text-violet-300` paths/commands,
`text-zinc-300` output, `text-amber-300` warnings, `text-zinc-500` comments.

### 3.9 Asymmetric bento grid

Features use `grid-cols-6` with mixed spans (`md:col-span-4 md:row-span-2`, `md:col-span-2`,
`md:col-span-3`) so the grid feels editorial, not a uniform 3×N. Hero uses `md:grid-cols-5` (3 + 2).

### 3.10 Buttons

- **Primary (emerald)**: `rounded-full bg-emerald-400 text-emerald-950 py-3 pl-6 pr-2` + a circular
  `bg-emerald-950/15` chip holding an arrow that does `group-hover:translate-x-1 -translate-y-px scale-105`.
- **Light**: `bg-zinc-100 text-zinc-900` (nav CTA / email submit).
- **Ghost**: `border-white/10 bg-white/[0.03] backdrop-blur-xl hover:bg-white/[0.06]`.
- Press feedback: `active:scale-[0.97]/[0.98]`.

---

## 4. Layout & spacing rhythm

- Section container: `mx-auto max-w-7xl px-4 md:px-8`, vertical `py-28 md:py-40`.
- Section header block: `mx-auto max-w-3xl text-center` → eyebrow pill + `font-display` h2 + zinc-400 lede.
- Eyebrow pill: `rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[10px] uppercase tracking-[0.2em]`
  in the section's accent (emerald or violet `/90`).
- Card grid gap: `gap-5`. Card inner padding: `p-6`–`p-9`.

---

## 5. Accessibility & polish (don't skip)

- `@media (prefers-reduced-motion: reduce)` disables reveals/sparklines/caret/bars and forces final state.
- `::selection { background: rgba(16,185,129,0.30); color:#ecfdf5; }`.
- `aria-hidden="true"` on decorative mesh/grain. `aria-label` toggling on the menu button.
- `scroll-smooth` on `<html>`; orbs use **transform-only** rAF parallax (never layout-thrashing props).
- `color-scheme: dark` so form controls/scrollbars match.

---

## 6. Anti-patterns (what breaks the look)

- ❌ Single-layer cards (no bezel) → flat. Always nest the concentric inner core.
- ❌ Pure black `#000` page bg → use `#050505`; pure-white text → use `zinc-50`.
- ❌ More than one emphasis hue per heading; a third accent color anywhere.
- ❌ Mismatched easing (default `ease-in-out`) → always `ease-silk`.
- ❌ Dropping the grain/mesh → the depth collapses.
- ❌ Inner radius not `calc(outer − padding)` → corners look "off".

---

## 7. Porting to the Expo app (NativeWind v4)

The mobile app (`DevDashboard/mobile/`) is on **NativeWind v4.2.4** (DECISIONS D15) with the same palette
exposed as `--dd-*` tokens. Mapping:

- `--dd-bg` ≈ `#050505`, `--dd-surface` ≈ `#0a0b0d`, `--dd-accent` ≈ emerald `#10b981`,
  `--dd-accent-2` ≈ violet `#8b5cf6`, text scale via the zinc ramp.
- Double-bezel → a `<Card>` primitive: outer `View` (border-white/10, bg-white/3, p-1.5, rounded-[2rem])
  wrapping an inner `View` (bg-[--dd-surface], rounded, ring). The `inset-hi` highlight → a top hairline
  `border-t border-white/10` or a subtle inner shadow.
- Mesh orbs → a `Canvas`/Skia radial-gradient layer or large blurred `View`s behind a `z`-stacked content
  view. Grain → a tiled noise image at low opacity.
- Motion → `react-native-reanimated` with an equivalent silk easing (`Easing.bezier(0.32,0.72,0,1)`);
  sparklines → **victory-native XL** (Skia) per D14, which is already the chart engine.
- Fonts → load Clash Display / General Sans / Satoshi via `expo-font` (or `@expo-google-fonts` equivalents);
  keep `font-display` for headings, system mono for terminal/stat text.

Keep token NAMES identical between the landing CSS vars and the NativeWind config so a future v5 migration
(or a shared design-token export) is config-only.

---

## 8. Quick checklist to reproduce

- [ ] Invoke `high-end-visual-design` skill first.
- [ ] Fontshare: Clash Display + General Sans + Satoshi; `font-display` headings, `font-mono` labels/terminal.
- [ ] `#050505` page, `#0a0b0d` card cores, emerald-primary + violet-secondary, zinc text ramp.
- [ ] Mesh orbs (blur-120, opacity ~0.4) + grain SVG (opacity 0.035), fixed, behind `relative z-10` content.
- [ ] Every card = double-bezel with `calc(outer − padding)` inner radius + `.inset-hi`.
- [ ] `ease-silk` on all motion; `.reveal` blur-up via IntersectionObserver, staggered.
- [ ] `.grad-text` on one emphasis span per heading.
- [ ] Live micro-motion: pulse dot, caret, sparkline dash-draw, equalizer bars.
- [ ] Floating pill nav; emerald/light/ghost pill buttons with arrow-chip hover.
- [ ] `prefers-reduced-motion`, `::selection`, `aria-hidden` on decor.
