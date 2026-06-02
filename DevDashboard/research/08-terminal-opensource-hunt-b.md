# 08 — Terminal Open-Source Hunt (Strategy B: by LIBRARY / CODE)

> Goal: via `gh_grep` code search + the npm registry, find **every RN-embeddable terminal
> renderer** that could become a 3rd `TerminalRenderer` driver behind the two already-decided
> WebView options (A: react-native-webview → ttyd URL; B: react-native-webview hosting local
> xterm.js HTML + self-opened WS). Go beyond the known `@fressh/react-native-xtermjs-webview`.
> Be honest about the graveyard.
>
> Target stack: **Expo SDK 55 (GA Feb 2026), RN 0.83, React 19.2, New Architecture MANDATORY**,
> EAS dev-client/prebuild (config plugins + custom native code allowed).
>
> All metadata verified on **2026-05-29** against the live npm registry, GitHub REST API, and the
> repos' actual source trees. `[VERIFIED]` = I read the package.json / source / tree / npm record
> directly. `[CLAIMED]` = asserted by a README/blog I did not independently confirm.

---

## TL;DR

- **No library found is a true "3rd driver" that beats Options A/B.** Every real hit is either
  (1) *literally Option B pre-packaged*, (2) *a renderer swap that lives **inside** A/B*, or
  (3) graveyard / wrong-category. The honest answer to "could it beat the two WebView options" is
  **no — but two finds change how you build A/B.**

- **Top find #1 — `@fressh/react-native-xtermjs-webview` (npm v0.0.8) IS Option B, packaged.**
  [VERIFIED by reading `src/index.tsx`] It bundles xterm.js into a single inlined HTML
  (`source={{ html }}`), and exposes exactly the handle shape we want:
  `write(Uint8Array)` / `writeMany` / `flush` / `clear` / `focus` / `resize` / `fit` plus
  `onData(str)` + `onInitialized`. It even ships the **same rAF + 8 KB write-coalescer** the
  recommendation doc (06) specifies. **But:** v0.0.8, single maintainer, 12★ on the parent repo,
  zero npm dependents, and it **pins `react-native-webview@13.15.0`** as a peer + uses
  `source={{ html }}` — i.e. **directly on the #3863 iOS-Fabric blank-WebView fault line.**
  **Verdict: adopt the *pattern*, not the *dependency*. Vendor/crib its `bridge.ts` + HTML into
  our own Option-B impl** so we control the RNW version and the #3880 patch.

- **Top find #2 — `ghostty-web` (`coder/ghostty-web`, 2,498★, MIT) is a drop-in xterm.js
  *renderer upgrade* that lives inside A/B, not a new driver.** [VERIFIED via README + npm]
  It is **libghostty's real VT100 parser compiled to a ~400 KB WASM bundle**, with a
  **deliberately xterm.js-compatible API**: `import { init, Terminal } from 'ghostty-web'` →
  `new Terminal({...})`, `term.open(el)`, `term.onData(d => ws.send(d))`, `term.write(...)`.
  Migration is literally *change the import*. This is the same libghostty engine that reports
  02/06 said "has no RN binding" — **correct, it has no *native* RN binding, but it ships a
  *web/WASM* build that drops straight into our WebView HTML.** Higher VT fidelity than xterm.js
  (proper grapheme/complex-script handling, XTPUSHSGR/XTPOPSGR). **Verdict: a candidate
  *renderer* for the Option-B HTML, not a candidate *driver*** — evaluate only if xterm.js's
  rendering fidelity proves insufficient.

- **The native graveyard is confirmed empty, again — and the negatives are findings:**
  - `react-native-pty`, `react-native-node-pty`, `react-native-xterm`, `react-native-xtermjs`,
    `expo-terminal`, `react-native-terminal-view`, `xterm-react-native` → **all npm 404**
    [VERIFIED]. None exist.
  - `@next_term/native` v0.1.0-next.0 → **still ships ZERO native code** [VERIFIED via tree]:
    `packages/native/src/` is TS only; `turbo-module/NativeTerminalCore.ts` is an empty TS
    interface; no `.swift/.kt/.mm/.podspec/.gradle` anywhere in the repo.
  - **No Nitro-module / TurboModule VT-renderer terminal exists** [VERIFIED]: searching
    `react-native-nitro-modules` in package.json deps returns camera/video/reanimated/whisper —
    **nothing terminal**. Nobody has shipped a Nitrogen or Codegen native terminal view.
  - `OpenTUI` (`@jitl/opentui-react`, `justjake/opentui`) is the **inverse category** — a
    framework for *rendering React/Solid TO a terminal*, not embedding a terminal in a mobile
    app. Disqualified.
  - `zudvpn/ZudVPN` (154★) is a **real precedent** of xterm.js-in-WebView for a live terminal —
    but on **RN 0.63.3, abandoned since 2023-01**, pre-Fabric. **Reference-only.**

- **Bonus (out of renderer category, noted for the transport layer):**
  `@fressh/react-native-uniffi-russh` (npm v0.0.5, same author) — a **real Rust `russh` SSH
  client exposed to RN via uniffi**, i.e. a New-Arch-shaped *transport*. Irrelevant while we keep
  ttyd; relevant only if we ever drop ttyd for direct device→host SSH. One line, no further
  investment.

**Bottom line:** The code hunt produces **no driver that beats A/B**, but it de-risks B
(`@fressh` proves the exact bridge works and gives us code to crib) and surfaces one credible
*renderer* upgrade path (`ghostty-web`) that slots inside the WebView with an import swap.
**Confidence: HIGH** (every claim grounded in a read source tree / npm record).

---

## Methodology

Search axes actually run (not paraphrased):

1. **`gh_grep` code search** (literal patterns, the tool is grep-not-keyword):
   - `@xterm/xterm` in `package.json` (JSON) → only web apps (jupyterlab, vscode, freeCodeCamp,
     angular, open-webui, cloudflare/sandbox-sdk) — **no RN apps.**
   - `react-native-webview` in `package.json` → generic RN apps (joplin, shoutem, taro, stripe-rn)
     — none terminal.
   - `window.ReactNativeWebView.postMessage` in **HTML** → editor/pdf/epub/youtube webviews
     **plus `zudvpn/ZudVPN/assets/terminal/index.html`** (xterm.js + fitAddon + onData→postMessage
     — a real RN terminal-in-webview hit).
   - `new Terminal(` scoped to `react-native` → only Metro build tooling (`new Terminal(process.stdout)`),
     not VT terminals.
   - `from '@xterm/xterm'` in TSX under a `webview` path → no results.
   - `react-native-nitro-modules` in package.json → no terminal Nitro module exists.
2. **npm registry full-text search** (`registry.npmjs.org/-/v1/search`) on `xterm react-native`,
   `react-native terminal`, `expo terminal`, `@fressh`, `react-native ssh expo` — surfaced
   `ghostty-web`, `@jitl/opentui-*`, `xterm-for-react`, and the two `@fressh/*` packages.
3. **Direct `npm view`** on ~15 plausibly-named packages to separate exists-vs-404.
4. **GitHub REST API** for stars / pushed_at / archived / license, and **raw source reads** of the
   decisive files (`@fressh` `src/index.tsx` + `package.json` + README; `ghostty-web` README + npm
   exports; `@next_term` full recursive tree).

**Hard gate applied:** SDK 55 is New-Architecture-only. A JS-only WebView wrapper passes *iff* its
underlying `react-native-webview` ships New-Arch native code (it does — RNW 13.16.x, verified in
reports 01/06). A "native terminal" package fails unless it actually ships Fabric/TurboModule
native code — **none does.**

---

## Per-library findings

### A. `@fressh/react-native-xtermjs-webview` — **Option B, pre-packaged** *(top find)*

- **npm:** `@fressh/react-native-xtermjs-webview` **v0.0.8**, modified **2025-10-08**, MIT,
  **0 dependents**, ~346 monthly downloads [VERIFIED].
- **Repo:** monorepo `https://github.com/EthanShoeDev/fressh` — **12★**, 1 fork, **not archived**,
  last push **2026-01-14**, license `null` on the repo but the package itself is MIT [VERIFIED].
  Package source lives at `packages/react-native-xtermjs-webview/`.
- **What it renders the terminal with:** **xterm.js (`@xterm/xterm@^5.5.0` + `@xterm/addon-fit`)
  inside a `react-native-webview`.** The xterm client is built by Vite into a *single inlined
  HTML file* (`vite-plugin-singlefile`) and imported as `htmlString` via `?raw`, then passed as
  `source={{ html: htmlString }}`. So it is **Option B (local HTML + bridge), not Option A.**
  [VERIFIED by reading `src/index.tsx`.]
- **Does it expose a write/onData handle?** **Yes — exactly the shape report 06 wants** [VERIFIED]:
  ```ts
  export type XtermWebViewHandle = {
    write: (data: Uint8Array) => void;       // bytes in (batched)
    writeMany: (chunks: Uint8Array[]) => void; // bulk initial replay in one postMessage
    flush: () => void; clear: () => void; focus: () => void;
    resize: (size: { cols: number; rows: number }) => void; fit: () => void;
  };
  // props: onInitialized?(), onData?(str), size?, autoFit?, xtermOptions?, webViewOptions?
  ```
  It implements the **same rAF + 8 KB write-coalescer** the recommendation specifies, and bridges
  RN→WebView via `injectJavaScript('window.dispatchEvent(new MessageEvent("message",...))')` and
  WebView→RN via `onMessage`. It also wires `onContentProcessDidTerminate` (iOS crash) /
  `onRenderProcessGone` (Android crash) — the exact lifecycle hooks report 06 calls for. Default
  WebView props already include `keyboardDisplayRequiresUserAction: false`, `bounces: false`,
  `originWhitelist: ['*']`, Android zoom/multi-window disables.
- **New-Arch + Expo fit:** **Inherits react-native-webview's New-Arch support — so YES on the
  target stack, with one critical caveat.** The package itself has **no native code**; it's pure
  JS over RNW. **BUT it pins `react-native-webview@13.15.0` as a peer dep and uses
  `source={{ html }}` — the precise combination that triggers issue #3863 (iOS + Fabric → blank
  WebView).** Adopting it as-is reproduces the known bug; you'd still have to override the RNW
  version to 13.16.x and apply the #3880 patch. Expo-installable as a normal JS dep (no config
  plugin); requires dev-client/prebuild only because RNW does.
- **Maintenance:** Solo author (Ethan Shumate), v0.0.x, low activity (repo last push Jan 2026),
  0 npm dependents. **Not a flagship.** It is "real and shipped" (the `apps/mobile` Fressh SSH
  client uses it) but it is *thin and young*.
- **Could it be our 3rd driver / beat A/B?** **No — it doesn't add a category; it *is* Option B.**
  Its real value is as a **reference implementation we vendor/crib**, not a hard dependency:
  - **Crib:** its `bridge.ts` message protocol, the inlined-HTML build approach, the coalescer,
    and the crash-recovery hooks → straight into our own `WebViewHtmlTerminalRenderer`.
  - **Don't hard-depend:** the RNW 13.15.0 pin + `source={{ html }}` puts the #3863 risk *inside*
    a dependency we don't control, and a 0.0.8 / 12★ / 1-maintainer package is a supply-chain and
    bus-factor risk for a core surface.
- **Risk verdict (adoption):**
  - **As a reference to crib from → LOW.** It validates that our exact Option-B design works on
    a shipping app and gives us battle-tested glue code.
  - **As a hard `package.json` dependency → MEDIUM/HIGH.** Young, single-maintainer, pins the
    #3863-affected RNW line; we'd be debugging someone else's bridge on our critical path.

### B. `ghostty-web` (`coder/ghostty-web`) — **renderer upgrade INSIDE A/B** *(top find)*

- **npm:** `ghostty-web` **v0.4.0**, modified **2026-02-24**, **MIT**, zero runtime deps,
  exports `./dist/ghostty-web.js` (ESM) + `./ghostty-vt.wasm` [VERIFIED].
- **Repo:** `https://github.com/coder/ghostty-web` — **2,498★**, 130 forks, 23 contributors,
  "used by 300", **not archived**, last push **2026-04-13** (lib code through Feb 2026) [VERIFIED].
- **What it renders the terminal with:** **the real Ghostty (libghostty) VT100 emulator compiled
  to WebAssembly** — "the same battle-tested code that runs the native Ghostty app," ~400 KB WASM,
  built from the `ghostty-org/ghostty` submodule with a small patch by Coder; Mitchell Hashimoto's
  `libghostty` underpins it. **Not JS reimplementation, not canvas-only — a WASM VT engine with a
  DOM renderer.** [VERIFIED via README.]
- **Does it expose a write/onData handle?** **Yes — deliberately xterm.js-API-compatible**
  [VERIFIED from README usage]:
  ```js
  import { init, Terminal } from 'ghostty-web';
  await init();
  const term = new Terminal({ fontSize: 14, theme: {...} });
  term.open(document.getElementById('terminal'));
  term.onData((data) => websocket.send(data));   // user input out
  websocket.onmessage = (e) => term.write(e.data); // bytes in
  ```
  README states: *"Migrate from xterm by changing your import: `@xterm/xterm` → `ghostty-web`."*
  So it slots behind the **same `bridge.ts` contract** `@fressh` uses — it's an in-place renderer
  substitution within the WebView HTML, requiring an `await init()` (WASM instantiation) step.
- **New-Arch + Expo fit:** It is **web code**, not RN — so its "New-Arch fit" is *the WebView's*.
  It would run **inside the Option-B local HTML** (replacing xterm.js). No native RN binding, no
  Fabric component — and it is **NOT** the same as a native libghostty RN module (that still
  doesn't exist). Practical considerations for hosting in a WebView:
  - Must bundle the **~400 KB `ghostty-vt.wasm`** into / alongside the inlined HTML and ensure the
    WebView can fetch+instantiate it locally (WASM `init()` path). This is a real bundling task
    vs. xterm.js's pure-JS inline.
  - **SharedArrayBuffer / COOP+COEP cross-origin isolation:** the README/package give **no
    indication it requires threads or `SharedArrayBuffer`** (single ~400 KB module, `await init()`,
    "zero runtime dependencies"). Single-threaded WASM instantiation does **not** need
    cross-origin-isolation headers. *I did not find explicit confirmation either way in the docs,
    so treat "no header requirement" as **likely but unverified** — confirm on the WASM-in-WebView
    spike if pursued.*
- **Maintenance:** **Strong** — Coder-backed, 2.5k★, 23 contributors, active through 2026-04, MIT,
  born out of Coder's `mux` desktop app. By far the healthiest project in this hunt.
- **Could it be our 3rd driver / beat A/B?** **It is not a driver — it's a *renderer* that lives
  inside drivers A/B.** It cannot "beat" A/B because it doesn't replace the transport/host layer
  (still WebView + WS). What it *can* beat is **xterm.js's rendering fidelity** (complex scripts,
  full SGR push/pop, grapheme handling) if that ever matters for our tmux/nvim/CJK usage. It is
  the realistic answer to "what about libghostty?" — you get libghostty's parser **in the browser**
  for free, without writing a native module.
- **Risk verdict (as an Option-B renderer): MEDIUM** — healthy upstream + drop-in API, but it's
  v0.4.0/young, adds a ~400 KB WASM payload + an `init()` async step + an unverified
  cross-origin-isolation question to the WebView. **Use only if xterm.js fidelity is measured
  insufficient; xterm.js stays the default.**

### C. `zudvpn/ZudVPN` — real xterm-in-WebView precedent, but dead & pre-Fabric *(reference-only)*

- **Repo:** `https://github.com/zudvpn/ZudVPN` — **154★**, 14 forks, TypeScript, **last push
  2023-01-06**, not archived but effectively abandoned, AGPL-3.0 [VERIFIED].
- **What it renders with:** **xterm.js in a WebView** — `assets/terminal/index.html` runs
  `new Terminal()` + `FitAddon` and `terminal.onData(data => window.ReactNativeWebView.postMessage(...))`
  [VERIFIED via gh_grep]. A genuine "stream a remote shell into an RN WebView terminal" precedent.
- **New-Arch + Expo fit:** **FAIL.** RN **0.63.3** (years pre-Fabric), bare RN (not Expo), uses
  `react-native-navigation` (Wix) — would need a total upgrade. Old-arch.
- **Maintenance:** Dead since early 2023.
- **Could it be our 3rd driver / beat A/B?** No — it's the *same* WebView+xterm pattern, just an
  old, abandoned instance. **Value = corroborating evidence that the Option-B pattern is the
  community-proven approach** (alongside `@fressh` and the archived omnara from report 06).
- **Risk verdict: HIGH (disqualified as a dependency; reference-only).**

### D. `@next_term/*` (`rahulpandita/react-term`) — native package STILL ships zero native code

- **npm:** `@next_term/native` **v0.1.0-next.0** (modified 2026-04-16), `@next_term/core`
  **v0.0.1-next.0** [VERIFIED].
- **Re-verified the central fact from report 02:** the recursive GitHub tree shows
  `packages/native/src/` contains **only** TS files (`NativeTerminal.tsx`, `TerminalSurface.tsx`,
  `renderer/SkiaRenderer.ts`, `turbo-module/NativeTerminalCore.ts`, tests). **No `.swift`, `.kt`,
  `.mm`, `.m`, `.podspec`, `build.gradle`, `.cpp`, `.h` anywhere in the repo** [VERIFIED]. The
  "TurboModule" is a TypeScript interface stub; the renderer is a JS Skia-draw fallback
  (and `@shopify/react-native-skia` isn't even a declared dep).
- **New-Arch + Expo fit:** Fails the gate — the native side does not exist.
- **Could it be our 3rd driver / beat A/B?** No. At most a *parser* reference (`@next_term/core`'s
  VTParser/BufferSet), but it's ~3★, AI-authored, pre-1.0, 0 dependents.
- **Risk verdict: HIGH (disqualified).**

### E. `OpenTUI` (`@jitl/opentui-react`, `justjake/opentui`) — inverse category

- **npm:** `@jitl/opentui-react` / `@jitl/opentui-core` (active, 2026-05-28); upstream
  `justjake/opentui` (18★) / `anomalyco/opentui` (the org repo) [VERIFIED].
- **What it is:** A framework for **building TUIs** — rendering React/Solid component trees *to a
  terminal* (the inverse of what we need). It does **not** embed a remote terminal session in a
  mobile app. **Wrong category entirely.**
- **Risk verdict: N/A (disqualified by category).**

### F. `xterm-for-react` — web-only React wrapper

- **npm:** `xterm-for-react` v1.0.4, modified **2022-05-25** (3+ years stale), `robert-harbison/`.
- A thin React DOM wrapper around xterm.js for **web** apps — no React Native, no WebView. If we
  ever wanted a React component inside the Option-B HTML it's a possibility, but it's stale and
  trivially replaceable by mounting xterm.js directly. **Not relevant to RN.**
- **Risk verdict: N/A (web-only, stale).**

### G. `@fressh/react-native-uniffi-russh` — *transport*, not renderer *(bonus, out of scope)*

- **npm:** `@fressh/react-native-uniffi-russh` **v0.0.5**, modified 2025-10-08, MIT [VERIFIED].
- **What it is:** **uniffi bindings for Rust `russh`** — a real native SSH client exposed to RN
  (New-Arch-shaped, the architecture you'd want for direct device→host SSH). It is a **transport**,
  not a terminal renderer (no VT/ANSI parsing, no scrollback). Same author as `@fressh` xterm pkg;
  the Fressh app pairs the two (russh transport → xterm-webview renderer).
- **Relevance:** **Zero while we keep ttyd** (ttyd already owns the PTY + transport on the dev box;
  the device only needs render + WS). Relevant **only** as a contingency if we ever abandon ttyd
  for direct SSH from the phone — and even then it's young (v0.0.5, 0 dependents). **One line of
  awareness, no investment.**
- **Risk verdict: N/A for the renderer question; HIGH if adopted as a transport today.**

---

## Cross-cutting conclusions

1. **There is no off-the-shelf RN terminal *renderer* that is a new driver category.** Everything
   real is xterm.js-in-WebView (= our Option B) or a renderer that runs *inside* a WebView
   (`ghostty-web`). The native side remains a graveyard: no `react-native-pty`/`-node-pty`, no
   `*-xterm` RN package, no Nitro/TurboModule VT view, `@next_term` native is an empty scaffold,
   SwiftTerm/jackpal have no RN binding (reports 02/06). **Verified negatives are themselves the
   finding.**

2. **`@fressh/react-native-xtermjs-webview` collapses the "build Option B from scratch" task into
   "crib a proven bridge."** It is the single most useful code artifact this hunt produced — it
   *is* Option B, with the right handle shape and the right coalescer, already running in a shipped
   app. But adopt it by **vendoring/cribbing**, not by hard-depending, because of the RNW 13.15.0 +
   `source={{ html }}` #3863 exposure and the 0.0.8 / 12★ / solo-maintainer profile.

3. **`ghostty-web` is the realistic "libghostty" answer — but as a WebView renderer, not a native
   module.** It de-risks the "what if xterm.js fidelity isn't enough" worry without a native build:
   swap the import inside the Option-B HTML. Keep it on the bench; don't adopt preemptively
   (extra ~400 KB WASM + `init()` + an unverified cross-origin-isolation question).

4. **The decision is unchanged: ship A (ttyd URL), keep B (local HTML + WS) hot behind the
   `TerminalRenderer` seam.** This hunt adds two concrete assets to B's implementation:
   (a) `@fressh`'s bridge code to crib, and (b) `ghostty-web` as a future renderer upgrade — and a
   one-line note that `@fressh/react-native-uniffi-russh` exists if ttyd is ever dropped.

## Recommendation

- **Do not add a 3rd driver from this hunt.** No library beats A/B; the category that would
  (native RN terminal) does not exist.
- **When implementing Option B, vendor/crib `@fressh/react-native-xtermjs-webview`'s bridge +
  inlined-HTML + coalescer + crash hooks** into our own `WebViewHtmlTerminalRenderer`, under our
  controlled `react-native-webview@13.16.x` + the #3880 patch — rather than taking it as a
  hard dependency.
- **Park `ghostty-web` as the designated renderer-upgrade for Option B** (drop-in `@xterm/xterm`
  → `ghostty-web` import swap) to be evaluated *only* if measured xterm.js rendering fidelity
  (complex scripts, SGR push/pop, CJK/grapheme) proves insufficient. Verify on a spike that the
  WASM hosts in a local-HTML WebView without cross-origin-isolation headers before committing.
- **Note, don't act:** `@fressh/react-native-uniffi-russh` is the on-shelf RN SSH transport if the
  ttyd architecture is ever abandoned.

**Confidence: HIGH.** Every load-bearing claim is grounded in a directly-read source tree, npm
record, or GitHub API response on 2026-05-29. The decisive new facts — `@fressh` = packaged
Option B (read its `index.tsx`), and `ghostty-web` = xterm.js-API-compatible WASM renderer
(read its README + npm exports) — are **verified, not claimed.**
