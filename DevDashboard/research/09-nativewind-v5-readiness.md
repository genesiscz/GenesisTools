# 09 — NativeWind v5 Readiness (Expo SDK 55 / RN 0.83 / New Arch)

> Scope: assess whether NativeWind **v5** is safe as the styling foundation for a
> **commercial** Expo SDK 55 (RN 0.83, New Architecture) app, given a web dashboard that
> already uses Tailwind-style utilities + CSS custom-property tokens (`--dd-*`). Decision
> already made to *prefer* v5; this verifies safety and prepares a v4.2.4 fallback.
>
> Research date: **2026-05-29**. All version/date facts are from npm dist-tags and the
> nativewind GitHub repos as of this date.

---

## TL;DR — Verdict: `start-v4-migrate-later`

NativeWind **v5 is still a preview, not GA** (`5.0.0-preview.4`, published 2026-05-15 — the
same day as the v4.2.4 GA). The npm `latest` tag points at **4.2.4**; `preview` points at
`5.0.0-preview.4`. The maintainer's own GitHub Roadmap still carries open "**v5 stability**"
tracking issues (#1754–#1760, opened 2026-03-26) gating the `@latest` release, and there is a
cluster of **open, confirmed, runtime-crashing** bugs in the underlying `react-native-css`
runtime. There is **no published validation against Expo SDK 55 / RN 0.83** — the docs claim
"RN 0.81+", the official scaffolder (`rn-new@next --nativewind`) still targets **SDK 54**, and
the most-discussed bugs are on SDK 53/54.

For a commercial foundation, shipping on a preview with open `path.split is not a function`
crashes on `<TextInput>` and `color-mix` producing `NaN` color channels is an unacceptable
baseline. **Start on v4.2.4 (the GA line), keep the codebase v5-ready, and migrate when v5 hits a
stable `@latest` tag with SDK 55 validation.** The v4→v5 migration is config-level (CSS-first
`@theme`, drop babel plugin, add postcss + lightningcss pin) and does **not** require touching
your own `className` usage — so deferring costs little.

**Caveat that drops confidence to medium:** v4.2.4 *also* has no published SDK-55/RN-0.83
validation (it's the SDK 52–54 era, on Tailwind v3). On SDK 55, **both lines are canary** — so the
recommendation is "GA-with-known-bugs over preview-with-crashes," **gated on a smoke-build of
v4.2.4 against a real SDK 55 / RN 0.83 app first** (§6). If that smoke-build fails, the decision
collapses to "wait for v5 GA." This is why the verdict is `start-v4-migrate-later`, not a
confident endorsement of either line as production-proven on SDK 55.

**Nuance on the brief's "useCssElement wrapper requirement":** partly real, but **not** a blanket
mandate. `useCssElement` **is** a genuine export of `react-native-css` (v5's runtime) — verified
via GitHub: Evan Bacon's official Expo `with-tailwindcss` example and his `crispy` repo wrap
third-party / non-core components with it, e.g.
`useCssElement(RouterLink, props, {className: "style"})` for `expo-router`'s `Link`, and similar
for `BlurView`, `Image`, `react-strict-dom` elements. So for **third-party components that don't
natively accept `className`**, v5 does push you toward an explicit per-component wrapper (either
`useCssElement` or the unified `styled()`). **However**, plain RN core components keep the
wrapper-free `className` API — the old JSX-transform is replaced by an automatic **import-rewrite**
(`import {View} from 'react-native'` → `react-native-css/react-native`), so feature code using
`<View className=...>` needs no wrapper. Net: no *mass* wrapping of your own screens; wrapping is
scoped to third-party UI kit integration — same surface area as v4's `cssInterop`/`remapProps`.
See §4.

---

## 1. Current v5 status — exact version + date

`npm view nativewind dist-tags` / `time` on **2026-05-29**:

- `latest` → **`4.2.4`** (published **2026-05-15 21:55 UTC**) — this is the GA line.
- `preview` → **`5.0.0-preview.4`** (published **2026-05-15 22:36 UTC**) — still a **preview**.
- `nightly` → `0.0.0-nightly.f941c0d` (2026-05-16).

v5 preview release cadence (from npm `time`):

- `5.0.0-preview.0` — 2025-09-24
- `5.0.0-preview.1` — 2025-09-25
- `5.0.0-preview.2` — 2025-10-11
- `5.0.0-preview.3` — 2026-03-15
- `5.0.0-preview.4` — 2026-05-15 (latest)

**Conclusion: v5 has NOT gone GA.** It has been in preview for ~8 months (Sep 2025 → May 2026),
with only 5 preview drops. The official site labels it: *"Nativewind v5 is currently available
in preview. It is not intended for production use."* (https://www.nativewind.dev/v5).

---

## 2. Changelog / release-notes themes

v5 is a foundational re-architecture, not an incremental release. Dominant themes (from the v5
announcement + migrate-from-v4 guide):

1. **Tailwind CSS v4.1+ required.** Config moves from `tailwind.config.js` (JS) to **CSS-first
   `@theme`** directives. This is the single biggest conceptual change.
2. **`react-native-css-interop` renamed → `react-native-css`**, demoted from a pinned transient
   dep to a **peer dependency** you install and version yourself. NativeWind is "no longer tied
   to a specific version" — decoupling that, in practice, has produced version-pinning pain (§3).
3. **JSX transform removed → import-rewrite system.** Instead of overriding `jsxImportSource`,
   v5 rewrites `import {View} from 'react-native'` to `'react-native-css/react-native'`. Driven
   by the ecosystem shift to *pre-compiled* libraries (you can't override jsxImportSource on code
   that's already transformed).
4. **`cssInterop` + `remapProps` deprecated → unified `styled()` API** (same options, optional
   3rd "remapProps mode" param; `global:false` to scope).
5. **Reanimated v4+ required**; animations migrated from a custom engine to **Reanimated CSS
   animations** (visual differences possible).
6. **New-Arch required** for a number of styles; old arch "limited functionality, unsupported".
7. **JS theme helpers removed**, replaced by CSS functions: `platformColor()`, `hairlineWidth()`,
   `pixelRatio()`, `fontScale()`, etc. `platformSelect`/`pixelRatioSelect` → media queries.
   `vars()` for dynamic theming → **`VariableContextProvider`** component.
8. **Renames / behavioral diffs:** `elevation-sm`→`elevation-xs`, `elevation`→`elevation-sm`;
   `shadow-*` now emits `boxShadow` (visual diff vs old shadowColor/Offset/Opacity/Radius);
   line-height numerics parsed as `em` (was unitless); `rem` no longer runtime-mutable;
   dynamic-mapping modifier renamed to `@prop`.
9. **New capabilities added:** `position: static`, `align-content: space-evenly`, `filter()`,
   `backgroundImage()` (gradients), `box-sizing`, `display: contents`.

---

## 3. Open, high-severity / blocking issues (with numbers + dates)

Two repos matter: **`nativewind/nativewind`** (31 open) and the runtime
**`nativewind/react-native-css`** (20 open). Highlights as of 2026-05-29:

### Runtime crashes (the dealbreakers for a commercial app)

- **react-native-css #232** — *[V5] `<TextInput>` crashes when using `text-center` / `text-right`
  / `text-left`* (`react-native-css: path.split is undefined`). Open since **2025-11-24**, `bug`.
  A core text utility crashing is a baseline-trust killer.
- **react-native-css #288** — *`nativeStyleMapping` crashes when value is boolean
  (`path.split is not a function`)*. Open since **2026-02-26**. Same `path.split` failure class.
- **react-native-css #317** — *`bg-black/50` silently fails — NaN oklab channels from
  lightningcss `color-mix` resolution*. Open, **confirmed** by triage, since **2026-04-01**.
  Opacity-modifier colors (extremely common) producing `NaN` is severe.
- **react-native-css #293** — *Native Metro transformer crashes on Expo's `@expo/log-box` CSS
  modules with `Specifier` deserialization error*. Open since **2026-03-07** — Expo-internal
  collision, exactly the `failed to deserialize ... Specifier` family that also bites migrators.
- **react-native-css #245** — *Memory leak in `VariableContextProvider` when re-rendering with
  CSS variables*. Open since **2025-11-05**. `VariableContextProvider` is the *recommended* v5
  dynamic-theming primitive (replaces `vars()`), so a leak there hits the happy path.
- **react-native-css #343** — *TypeScript hangs when `styled()` wraps components with complex ref
  props*. Open, **confirmed**, since **2026-05-24** (newest). DX/build-time blocker for `styled()`.

### Correctness / variant bugs

- **react-native-css #297** — *`group-disabled:` (and likely other group attribute variants)
  always applied*. Open, **confirmed**, since **2026-03-12**.
- **react-native-css #254** — custom line-height via `leading-*` not applied. Open 2025-10-28.
- **react-native-css #338** — *Error when using with metro only* (needs-deep-triage), 2026-05-06.

### Light/dark + platformColor (explicitly flagged in the brief)

- **nativewind #1640 / react-native-css #255** — *`@media (prefers-color-scheme: dark)` not
  working on iOS (works on web)* with Expo 54. Open since **2025-10-12**, `help wanted`, on the
  maintainer **Roadmap (Todo)**. Duplicate-merged with **#1626** (*`colorScheme.get()` and `dark:`
  variants don't update in real-time on system theme change*). The maintainer's guidance is to use
  **class-based dark mode** in v5 rather than the media-query approach (Discussion #1617). For a
  themed commercial app this is a real friction point — the *recommended v5 dark-mode path differs
  from v4* and the media-query path is buggy on native.
- **nativewind #1475** — *Platform colors won't work (reanimation error) when used with
  transitions*. Open since 2025-05-08. (`platformColor` + transitions.)
- **nativewind #1476** — *Cannot use `var(--variable)` in `platformSelect`*. Open 2025-05-08 —
  directly relevant if you push `--dd-*` vars through platform selection.

### v5 stability tracking (maintainer-owned, gating `@latest`)

All opened by maintainer **danstepanov on 2026-03-26**, labeled **"v5 stability — Tracking v5
stability for @latest release"**, still **open**:
- **#1760** Verify SVG fill/stroke and line-clamp work end-to-end
- **#1759** Expand test coverage to match v4 utility coverage
- **#1758** Decide on `windows:`/`macos:` platform variant support
- **#1757** Switch `thumbColor`/`trackColor` prop mappings
- **#1756** `caret-*`, **#1755** `placeholder:`, **#1754** `selection:` prop mappings

> The existence of an open **"expand test coverage to match v4"** (#1759) item, owned by the
> maintainer, is the clearest possible signal that v5 is **not yet at v4 parity** and not yet
> blessed for `@latest`.

### Version-pinning / coupling pain (react-native-css decoupling backfired)

The headline migration footgun is the **lightningcss deserialization crash**:
`ERROR global.css: failed to deserialize; expected an object-like struct named Specifier, found ()`.
Reported repeatedly (Discussion #1617 by veffev/MartinCura Oct 2025; issue #238 Dec 2025) and the
*only* reliable fix is to pin lightningcss in `package.json`:
```json
{ "overrides": { "lightningcss": "1.30.1" } }
```
This is now **Step 6 of the official migration guide** — i.e., a known sharp edge that every
adopter must hand-pin. Decoupling `react-native-css` to a peer dep means **you** now own keeping
`nativewind` ↔ `react-native-css` ↔ `lightningcss` ↔ `tailwindcss@4.1+` ↔ `reanimated@4+`
mutually compatible. Non-Expo/bare RN guidance is still missing (#1699), and Next.js/Turbopack
support is incomplete (react-native-css #244 jsx-dev-runtime resolve error, Nov 2025).

### Recent v4-line instability (relevant if you stay on v4)

- **nativewind #1781** — *Styles dropped on RN primitives in **4.2.3** (works on 4.2.1)* with a
  `jsxImportSource: 'nativewind'` setup. Open 2026-05-07. → On v4 you want **4.2.4** (the fix
  line) and to follow the standard babel-preset setup, not the manual jsxImportSource path.
- **nativewind #1783** — *Incompatibility with React Navigation v8* (`Cannot read property 'get'
  of undefined`), **reproduced in CI**, open 2026-05-10. Watch your navigation version.

---

## 4. v4 → v5 migration cost

**Good news: the per-component cost on your own code is ~zero.** v5 explicitly "preserves its
existing API" — `className` and `styled` keep working without modification on RN core components.
The old JSX transform is replaced by an automatic **import rewrite** handled by the bundler plugin
— no source changes to `<View className=...>` etc. **The `useCssElement` / `styled()` wrapper IS
required, but only for third-party / non-core components** that don't natively accept `className`
(verified: Expo's own `with-tailwindcss` example wraps `expo-router` `Link`, `BlurView`, `Image`
via `useCssElement(Component, props, {className: "style"})`). That is the same integration surface
as v4's `cssInterop`/`remapProps` — so it's a known, bounded cost (your UI-kit shims), not a
sweeping per-screen tax.

The real migration cost is **config + tooling**, done once at the project root:

1. **CSS-first theme.** Delete `tailwind.config.js`; move tokens to `@theme` in `global.css`.
   Upgrade to **Tailwind CSS v4.1+** (run `npx @tailwindcss/upgrade`).
2. **CSS imports** change to the Tailwind-v4 layer form:
   ```css
   @import "tailwindcss/theme.css" layer(theme);
   @import "tailwindcss/preflight.css" layer(base);
   @import "tailwindcss/utilities.css";
   @import "nativewind/theme";
   ```
3. **Remove `nativewind` from `babel.config.js`** (the JSX-transform plugin is gone).
4. **Add `postcss.config.mjs`** with `@tailwindcss/postcss`.
5. **Metro:** `withNativewind(config)` (no 2nd arg; rename from `withNativeWind` is back-compat).
6. **Pin lightningcss** (`overrides.lightningcss = "1.30.1"`) or the build deserialization-crashes.
7. **Install peer deps:** `react-native-css`, `react-native-reanimated@4+`,
   `react-native-safe-area-context`.
8. **Behavioral fixups** (audit, not mechanical): `shadow-*` → boxShadow visual diff;
   `elevation*` renames; line-height `em` semantics; `rem` no longer runtime; `vars()` →
   `VariableContextProvider`; JS theme helpers → CSS functions; dark-mode strategy likely → class-based.

**Estimate:** for a fresh app, ½–1 day of config + a styling QA pass. Migrating *later* (after
shipping on v4) is the same config work plus a regression sweep — and crucially, **none of the
`className` strings change**, so deferral does not accumulate technical debt in feature code.

---

## 5. Does v5 cleanly map our `--dd-*` CSS-var tokens via `@theme`?

**Yes — conceptually this is v5's sweet spot, and our web side is already aligned.** The dev
dashboard's `slate-grid.css` defines **105** `--dd-*` references (e.g. `--dd-bg-base`,
`--dd-bg-panel`, `--dd-border`, `--dd-accent-from/-to`, `--dd-text-primary/-secondary/-muted`,
`--dd-danger`, `--dd-accent-glow`), and `styles.css` already uses Tailwind v4 CSS-first syntax
(`@import "tailwindcss"`, `@custom-variant dark (&:is(.dark *))`). That is exactly the model v5
consumes. Mapping pattern (proven in the wild, e.g. shadcn-native, react-native-css #255 repro):

```css
@theme {
  --color-bg-base: var(--dd-bg-base);
  --color-bg-panel: var(--dd-bg-panel);
  --color-border:   var(--dd-border);
  --color-accent:   var(--dd-accent-from);
  --color-text-primary: var(--dd-text-primary);
  /* ... */
}
:root {
  --dd-bg-base: #0c0e10;
  --dd-bg-panel: #101316;
  /* ...the existing palette... */
}
```
`bg-bg-base`, `text-text-primary`, `border-border`, etc. then work as utilities, and runtime
theme swaps go through `VariableContextProvider`.

**But native-specific caveats that block "clean":**

- **Gradients:** `--dd-accent-gradient: linear-gradient(...)` and `--dd-accent-glow` box-shadows
  do **not** map 1:1. RN has no real gradients; v5 adds `backgroundImage()` for *gradients only*
  and `shadow-*`→`boxShadow`, but glow/`box-shadow 0 0 14px` effects and `color-mix(in srgb, ...)`
  used heavily in `slate-grid.css` are web-CSS features. `color-mix` specifically is implicated in
  the **NaN-channel crash (react-native-css #317)** — so any `--dd-*` token resolved through
  `color-mix` is a live risk on native.
- **Opacity modifiers** (`bg-foo/50`) hit the same #317 `color-mix` path. Common in dark UIs.
- **`var()` in `platformSelect`** is unsupported (nativewind #1476) — relevant if you platform-fork
  token values.
- **Dynamic dark-mode** of these vars on native is the buggy path (#1640/#1626); v5 wants
  class-based dark mode, so plan the theming API around that, not `@media`.

**Net:** flat color/spacing `--dd-*` tokens map cleanly via `@theme`; gradient/glow/`color-mix`
effects need native-specific re-expression and currently brush against open crash bugs. The web
dashboard's CSS is **not** directly reusable on native regardless of v4-vs-v5 — RN renders a
subset. The token *naming* transfers; the *effects* must be re-authored for native.

---

## 6. Final verdict + fallback plan

### Verdict: `start-v4-migrate-later`

**Rationale.** v5 is the correct *destination* (CSS-first `@theme`, our tokens map, the web side is
already Tailwind v4, the migration leaves feature-code `className` untouched). But for a
**commercial** foundation, **today** it is too raw:

- Not GA — `latest` is 4.2.4; v5 is `preview.4` and labeled "not for production". (§1)
- Maintainer's own gating issues say v5 is **not at v4 utility/test parity** (#1759). (§3)
- Open, confirmed **runtime crashes** on bread-and-butter utilities: `<TextInput>` + `text-*`
  (#232), boolean `nativeStyleMapping` (#288), `color-mix`/opacity → NaN (#317),
  `VariableContextProvider` memory leak (#245). (§3)
- **Zero published Expo SDK 55 / RN 0.83 validation.** Docs claim RN 0.81+; the scaffolder
  (`rn-new@next`) still targets **SDK 54**; reported bugs cluster on SDK 53/54. Adopting v5 on
  SDK 55 means being the canary. (§1, §3)
- Migrating *later* is cheap (config-only, no `className` churn). (§4)

This is **not** `start-v4-stay`: v5 is clearly where the project should land, and v5-readiness
should be designed in from day one. It is **not** `proceed-with-v5`: a preview with open color and
text-input crashes is an unacceptable commercial baseline, and the brief's stated v5 prerequisite
(`useCssElement` wrapper) was a misconception — there's no API forcing-function pulling us onto v5
now.

### Concrete fallback / forward plan

> **Honest caveat — the v4 fallback is NOT a fully-settled platform on SDK 55 either.** I held v5
> to an SDK-55/RN-0.83-validation bar; v4.2.x must face the same bar, and it also **lacks published
> SDK-55/RN-0.83 validation**. Confirmed facts: SDK 55 = **RN 0.83 + React 19.2 + New-Arch-always-on**
> (Expo changelog). NativeWind **v4.2.x is the SDK 52–54 era**; the entire v4 docs/setup canonically
> use the `babel-preset-expo {jsxImportSource:'nativewind'}` + `nativewind/babel` path — which is
> exactly the path that **issue #1781 reports dropping styles on 4.2.3** and **#1775** flags as
> forcing the wrong jsx-runtime on Expo. There is no v4 doc page or release note asserting RN-0.83
> support. **Conclusion: on SDK 55, BOTH lines are canary.** The verdict still holds — a **GA line
> with known, individually-diagnosable bugs** is a safer commercial baseline than a **preview with
> open color/text-input crashes and a maintainer-acknowledged test-parity gap** — but v4.2.4 is a
> *less-bad* canary, not a guaranteed safe harbor. **Validate it on a real SDK 55 build before
> committing** (see step below). Confidence is therefore **medium**, gated on that build passing.

**Now — ship on NativeWind v4.2.4 (GA), after a smoke-build validation:**
- **First gate:** stand up a throwaway Expo SDK 55 (RN 0.83) app, install `nativewind@4.2.4`, and
  confirm styles actually render (text, layout, dark-mode, opacity colors) on iOS + Android. If
  this fails, v4 is no safer than v5 and the decision collapses to "wait for v5 GA" — re-evaluate.
- `nativewind@4.2.4` exactly (avoid 4.2.3 — styles-dropped regression #1781), `tailwindcss@^3.4`,
  Reanimated as per SDK 55, New Arch on (forced in SDK 55).
- Use the standard **babel-preset** setup. Be aware the v4 `jsxImportSource:'nativewind'` path is
  the one implicated in #1781/#1775 — if you hit dropped styles, that's the prime suspect; test the
  alternate `nativewind/babel`-only configuration as a mitigation.
- Pin exact versions (no `^`/`latest`) in `package.json` for `nativewind`, `tailwindcss`,
  `react-native-reanimated` — the v5 line proved how much version drift hurts.

**Design for v5-readiness from day one (zero/low cost):**
- **Version-split caveat:** the v4.2.4 fallback runs on **Tailwind v3** (`tailwind.config.js`),
  where `@theme` does **not** exist — so on the v4 line you map `--dd-*` tokens via the JS config's
  `theme.extend.colors` (referencing the CSS vars), *not* `@theme`. Note this also means a transient
  **version split**: web dashboard on Tailwind **v4** (already migrated) vs native on Tailwind **v3**
  until the v5 flip. The readiness prep is therefore real but more limited than a pure `@theme`
  story: keep token *names* stable so the eventual `tailwind.config.js` → `@theme` move is a
  mechanical port.
- Author **token names** to match the future `@theme` mapping (`--color-*` aliasing `--dd-*`), so
  the eventual `@theme` block is a rename, not a redesign.
- Prefer **class-based dark mode** (`dark:` via a `.dark` class toggled by a ThemeProvider) over
  `@media (prefers-color-scheme)` — this is v5's recommended path *and* works on v4, so no rework.
- Avoid `color-mix()`/heavy opacity-modifier reliance in the *native* token layer (re-express
  glow/gradient effects as solid tokens or `expo-linear-gradient`), sidestepping #317.
- Keep custom/third-party component styling funneled through one helper so the v4 `cssInterop`
  → v5 `styled()` swap is a single-file change.

**Migration trigger (when to flip to v5):** all of —
1. npm `latest` (not `preview`) points at a `5.x` stable, AND
2. v5-stability tracking issues #1759 (test parity) + the text-input/color-mix crashes
   (react-native-css #232, #288, #317) are **closed**, AND
3. there is a published SDK-55/RN-0.83 success path (template or docs), AND
4. a 1–2 week soak on a feature branch passes a full styling QA sweep (text alignment, opacity
   colors, dark-mode toggle, gradients/shadows, theme-swap perf/leaks).

**Cost of the flip:** ~½–1 day config + a styling regression sweep; **no feature-code
`className` changes** (§4).

---

## Sources

- npm: `npm view nativewind dist-tags / time` (2026-05-29) — `latest 4.2.4`, `preview 5.0.0-preview.4`.
- NativeWind v5 migration guide — https://www.nativewind.dev/v5/guides/migrate-from-v4
- v5 announcement — https://www.nativewind.dev/blog/v5-migration-guide (labels v5 "preview … not for production")
- v5 site root — https://www.nativewind.dev/v5
- Discussion #1617 (v4→v5 migration trouble; lightningcss deserialize; dark-mode broken) — nativewind/nativewind
- Issue #238, #244, #248 — nativewind/react-native-css (V5 install/config)
- react-native-css open issues: #343, #338, #317, #297, #293, #288, #254, #245, #232 (2026-05-29 snapshot)
- nativewind open issues: #1783, #1781, #1775, #1760–#1754 (v5 stability), #1640, #1626, #1476, #1475
- Expo SDK 55 changelog — https://expo.dev/changelog/sdk-55 ("SDK 55 includes React Native 0.83 and
  React 19.2"); New Arch always-on in 55 — https://docs.expo.dev/guides/new-architecture/
- `useCssElement` is real (GitHub gh_grep): `expo/examples` `with-tailwindcss/src/tw/index.tsx` +
  `image.tsx`, and `EvanBacon/crispy` `src/tw/{index,touchable,glass}.tsx` —
  `useCssElement(Component, props, {className: "style"})` to wrap third-party components.
- v4 SDK-55 absence: no v4 release note / docs page asserts RN 0.83 support; v4 setup canonically
  uses `jsxImportSource:'nativewind'` (nativewind #981, #1004, #1364) — the path #1781/#1775 flag
  as unstable on the 4.2.x line.
- Project local: `src/dev-dashboard/ui/src/slate-grid.css` (105 `--dd-*` refs),
  `src/dev-dashboard/ui/src/styles.css` (already Tailwind v4 CSS-first + `@custom-variant dark`).
