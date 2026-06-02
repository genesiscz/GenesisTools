# 10 — 3rd TerminalRenderer Driver: Synthesis + Adversarial Verification (FINAL)

> Synthesizes reports **07** (hunt by product/app) and **08** (hunt by library/code), independently
> re-verifies the load-bearing claims against the live npm registry + GitHub API + raw source on
> **2026-05-29**, and renders the final go/no-go on a 3rd `TerminalRenderer` driver.
>
> Target stack: **Expo SDK 55 (GA Feb 2026), RN 0.83, React 19.2, New Architecture MANDATORY**,
> EAS dev-client/prebuild (config plugins + custom native code allowed).
>
> `[VERIFIED]` = I personally read the npm record / source tree / GitHub API response in *this*
> session (not relayed from 07/08). `[CONFIRMS 07/08]` = my independent check reproduced their claim.

---

## ┌─────────────────────────────────────────────────────────────────────────┐
## │  VERDICT                                                                  │
## └─────────────────────────────────────────────────────────────────────────┘

**NO credible 3rd `TerminalRenderer` driver exists to adopt now. The two-WebView-drivers-plus-
in-app-switcher plan STANDS.**

- Ship **Driver A** = `react-native-webview` → existing **ttyd URL** (`/ttyd/<id>/`) as v1.
- Keep **Driver B** = `react-native-webview` hosting **local xterm.js HTML + self-opened WS** hot
  behind the `TerminalRenderer` seam.
- Both selectable via the in-app **switcher** (the `TerminalRenderer` interface is the swap point).
- The **only** genuine "3rd driver *category*" — a **native VT engine (SwiftTerm) wrapped in an
  Expo native module** — does **not exist off the shelf** (no RN binding anywhere) and remains a
  **pre-designed, deferred escape hatch**, built *only if* measured nvim/tmux WebView redraw
  latency proves unacceptable. It is buildable, not adoptable.

The two hunts converged on this from **independent axes** (by-product vs by-library); my
independent checks (npm 404 sweep, `react-native-nitro-modules` package.json grep, `ghostty-web`
consumer grep, raw reads of `@fressh` `index.tsx` + both `package.json`s + LICENSE) reproduced
every load-bearing claim. **Confidence: HIGH.**

---

## Ranked table (0–100)

**Ranking axis = "viability as a *distinct 3rd driver* that plugs into `TerminalRenderer` and
beats A/B."** This axis intentionally scores *driver candidacy*, NOT overall usefulness — the two
highest-value finds (`@fressh`, `ghostty-web`) score **low as drivers** because one *is* Driver B
and the other is a *renderer inside* B. Their value is captured in the "Asset value" column, which
is a different question.

| # | Candidate | Driver score | What it actually is | Asset value to us | Risk |
|---|-----------|:-----------:|---------------------|-------------------|:----:|
| 1 | **Native SwiftTerm + Expo module** (to-be-built) | **45** | The *only* true 3rd-driver category: native VT engine, not WebView. But **no RN binding exists** — multi-month 2-platform build. | Escape hatch (deferred) | HIGH (build) |
| 2 | `@fressh/react-native-xtermjs-webview` | **15** | **IS Driver B, pre-packaged** (xterm.js in inlined-HTML WebView). Not a new category. | **HIGHEST**: crib its bridge/HTML/coalescer | MED (as dep) / LOW (as crib) |
| 3 | `ghostty-web` (coder) | **10** | **Renderer that lives *inside* B** (libghostty→WASM, xterm-API-compatible). Not a driver. | HIGH: fidelity upgrade for B's HTML | MED |
| 4 | Termix | 5 | Electron + xterm.js v6 web app. No RN code. | Web-layer reference for B | n/a |
| 5 | Tabby / Hyper / Wave | 5 | Electron + xterm.js, desktop only. | Architecture lessons | n/a |
| 6 | Termius (closed) | 5 | Closed-source web-tech core. | **Mobile-input UX** reference → `MobileKeyBar` | n/a |
| 7 | Blink / a-Shell (iOS) | 4 | Native iOS apps hosting hterm-in-WKWebView. | Proof WebView ships at pro quality | n/a |
| 8 | Secure ShellFish (closed) | 4 | Native SwiftTerm app. | Native-escape-hatch exemplar | n/a |
| 9 | Warp | 3 | Native Rust GPU UI, desktop, **AGPL**. | Worse than SwiftTerm (license + no mobile) | HIGH |
| 10 | `react-native-ssh-sftp` (+ fork) | 2 | SSH/SFTP **transport only**, no VT/renderer. | Wrong layer | HIGH |
| 11 | `@fressh/react-native-uniffi-russh` | 2 | Rust russh SSH **transport** via uniffi. | Only if ttyd ever dropped | HIGH |
| 12 | `@next_term/native` | 0 | Claims TurboModule VT view; **ships zero native code** (empty TS scaffold). | None | dead |
| 13 | OpenTUI / xterm-for-react / zudvpn | 0 | Wrong category / web-only / dead pre-Fabric. | Reference-only | dead |

> Read this as: the field collapses into **two rendering camps** — xterm.js/hterm-in-a-web-surface
> (= our A/B) and native-VT-engine (the deferred escape hatch). There is **no third rendering
> technology** that is simultaneously RN/Expo-embeddable, New-Arch-ready, and better than A/B.

---

## Per-candidate verification (the load-bearing checks I re-ran)

### `@fressh/react-native-xtermjs-webview` — IS Driver B, pre-packaged `[VERIFIED]`

- **npm:** v0.0.8, MIT, modified 2025-10-08, `dependencies: { js-base64 }`, **peers pinned as
  EXACT versions: `react: "19.1.0"`, `react-native-webview: "13.15.0"`** (not caret ranges).
  `[VERIFIED via npm view]` `[CONFIRMS 08]`
- **Handle shape `[VERIFIED — read `src/index.tsx`]`:** exposes exactly
  `write(Uint8Array) / writeMany / flush / clear / focus / resize / fit` + props
  `onInitialized / onData(str) / size / autoFit / xtermOptions / webViewOptions`. Implements the
  **rAF + 8 KB coalescer** (`defaultCoalescingThreshold = 8 * 1024`), bridges RN→WebView via
  `injectJavaScript('window.dispatchEvent(new MessageEvent("message",…))')` and WebView→RN via
  `onMessage`, and wires **`onContentProcessDidTerminate`** (iOS crash) + **`onRenderProcessGone`**
  (Android crash). Source = inlined HTML: `import htmlString from '../dist-internal/index.html?raw'`
  → `source={{ html: htmlString }}`. This is **Driver B, verbatim.** `[CONFIRMS 08]`
- **Repo health `[VERIFIED via GitHub API]`:** `EthanShoeDev/fressh` — **12★**, 1 fork, NOT archived,
  last push **2026-01-14**. Solo maintainer. Thin/young. `[CONFIRMS 08]`
- **License nuance `[VERIFIED — NEW]`:** GitHub's repo `/license` endpoint returns **404** and there
  is **no root `LICENSE` file** — BUT the **package directory has its own `LICENSE` (MIT, "Copyright
  (c) 2025 EthanShoeDev")** at `packages/react-native-xtermjs-webview/LICENSE` (HTTP 200, read).
  So cribbing is **legally clean at the package level** under MIT; the repo-root 404 is just a
  per-package monorepo convention, not a missing license. (07/08 reported `license: null` on the
  repo object without noting the package-level file — see Corrected claims.)
- **Driver verdict:** **Not a 3rd driver — it *is* Driver B.** Value = **crib** its bridge protocol,
  inlined-HTML build, coalescer, and crash hooks into our own `WebViewHtmlTerminalRenderer`. **Do
  NOT hard-depend:** the **exact** `react-native-webview@13.15.0` + `react@19.1.0` peer pins will
  throw peer conflicts on SDK 55 (React 19.2 / RNW 13.16.x), forcing `overrides` — and a
  0.0.8/12★/solo package on a core surface is a bus-factor + supply-chain risk that also re-imports
  the #3863 `source={{html}}` iOS-Fabric fault line inside a dependency we don't control.
- **Risk: LOW as a crib (MIT, confirmed); MED/HIGH as a hard dependency.**

### `ghostty-web` — renderer INSIDE B, not a driver `[VERIFIED]`

- **npm:** v0.4.0, **MIT**, modified 2026-02-24. `[VERIFIED via npm view]` `[CONFIRMS 08]`
- **Repo health `[VERIFIED via GitHub API]`:** `coder/ghostty-web` — **2,499★**, 130 forks, NOT
  archived, last push **2026-04-13**. License endpoint → **MIT** (`spdx_id: MIT`). By far the
  healthiest project in the hunt. `[CONFIRMS 08]`
- **What it renders with `[VERIFIED — read README + consumer code]`:** libghostty's real VT100
  emulator compiled to **~400 KB WASM** ("the same code that runs the native Ghostty app"),
  **deliberately xterm.js-API-compatible**: `import { init, Terminal } from 'ghostty-web'` →
  `await init()`, `term.open(el)`, `term.onData(d => ws.send(d))`, `ws.onmessage = e => term.write(e.data)`.
  README: *"Migrate from xterm by changing your import: `@xterm/xterm` → `ghostty-web`."* Beats
  xterm.js on complex-script/grapheme handling + XTPUSHSGR/XTPOPSGR. `[CONFIRMS 08]`
- **In-the-wild check `[VERIFIED via gh_grep]`:** real consumers — `openchamber`, `hotovo/aider-desk`,
  `coollabsio/jean`, `nimbalyst`, `mwguerra/web-terminal`. **Every one is Electron/web; NONE is
  React Native.** Confirms it is a *web/WASM* renderer with **no native RN binding** (README even
  says it "will eventually consume a native Ghostty WASM distribution" — i.e. still web-only today).
- **Driver verdict:** **Not a driver — it's a *renderer* that swaps in inside Driver B's HTML** (an
  import change behind the same bridge contract). Park as the **designated fidelity upgrade** for B,
  evaluated only if xterm.js's rendering proves insufficient. Adds ~400 KB WASM + an async `init()`.
- **Risk: MED** (young v0.4.0; healthy upstream; WASM bundling + COOP/COEP question, see Integration).

### Native graveyard — re-confirmed empty `[VERIFIED]`

- **npm 404 sweep (re-run this session):** `react-native-pty`, `react-native-node-pty`,
  `react-native-xterm`, `react-native-xtermjs`, `expo-terminal`, `react-native-terminal-view`,
  `xterm-react-native` → **all E404.** None exist. `[CONFIRMS 02/08]`
- **No Nitro/TurboModule VT view `[VERIFIED via gh_grep]`:** searching `react-native-nitro-modules`
  in `package.json` returns only whisper (joplin), hashcash (uniswap), video, vision-camera,
  llamacpp (runanywhere) — **zero terminal.** Nobody has shipped a Nitrogen/Codegen native terminal.
  `[CONFIRMS 08]`
- **`@next_term/native`** still ships zero native code (empty TS scaffold) — relayed from 07/08, not
  re-walked this session; consistent with the 404 sweep.

### Products (07) — re-confirmed reference-only `[VERIFIED where checked]`

- **Termix:** `[VERIFIED via GitHub API]` **13,084★**, NOT archived, last push **2026-05-29** (today)
  — extremely active. Electron + xterm.js v6, no RN code → web-layer reference for B. `[CONFIRMS 07]`
- **Termius / Tabby / Hyper / Wave / Warp / Blink / Secure ShellFish / a-Shell:** accept 07's
  primary-source classification (closed-source web-tech core; Electron+xterm.js desktop; native
  Swift/Rust). None RN-embeddable; all reference-only. Not independently re-walked (07 cited primary
  sources directly); no claim here depends on them being drivers.

---

## Integration note — how the seam works

The `TerminalRenderer` interface is the single swap point. Conceptually each driver provides:
`mount(container) / write(bytes) / onData(cb) / resize(cols,rows) / dispose()` plus a transport hook.

- **Driver A (ttyd URL):** `react-native-webview` with `source={{ uri: '/ttyd/<id>/' }}`. ttyd owns
  the PTY, VT rendering (its own xterm.js), and the WS. The RN side is "just a WebView." Requires
  RNW **13.16.x + the #3880 patch** to dodge issue #3863 (iOS New-Arch blank `source`).
- **Driver B (local HTML + WS):** `react-native-webview` with `source={{ html }}` hosting our own
  xterm.js; RN opens the WS (token in WS subprotocol) and pumps bytes through the bridge.
  **Crib `@fressh`'s bridge.ts + inlined-HTML + coalescer + crash hooks** (MIT, package-level
  LICENSE confirmed) under our controlled RNW 13.16.x — do not hard-depend (peer-pin conflicts).
- **`ghostty-web` does NOT plug into the driver seam.** It is a **renderer substitution *inside*
  Driver B's HTML** — `@xterm/xterm` → `ghostty-web` import swap behind the *same* bridge contract,
  plus an `await init()` WASM step. **Caveat:** a `source={{html}}` WebView is an **opaque origin**
  and **cannot set COOP/COEP cross-origin-isolation headers**, so `SharedArrayBuffer` is unavailable.
  The upgrade is safe **only because ghostty-web's ~400 KB WASM is single-threaded** (no SAB
  required, per README "zero runtime dependencies" + single `await init()`). **Verify on a spike**
  that the WASM instantiates from inlined/bundled bytes inside the WebView before committing.
- **The would-be 3rd driver (native SwiftTerm + Expo module) IF ever built:** it would implement the
  *same* `TerminalRenderer` interface but back it with a **native Fabric view** (SwiftTerm on iOS;
  an Android VT engine TBD — SwiftTerm is iOS/macOS only, so Android needs a separate native engine
  or falls back to B). This is exactly why it's deferred: it's a multi-month, two-platform native
  build with no existing binding. Trigger to build = **measured** nvim/tmux redraw latency in the
  WebView being unacceptable. Until then, A/B + switcher is complete.

---

## Corrected / sharpened claims

1. **`@fressh` license is MIT and confirmed at the package level — not "null."** 07/08 reported the
   repo object's `license: null`. That is technically true of the *repo root* (no root LICENSE,
   `/license` API → 404), but **misleading**: the package ships its own MIT `LICENSE` file
   (`packages/react-native-xtermjs-webview/LICENSE`, "Copyright (c) 2025 EthanShoeDev", HTTP 200,
   read this session). **Cribbing is legally clean under MIT** — the earlier "null" framing
   understated the cribbing risk's resolution.
2. **`@fressh` peers are pinned as EXACT versions, not ranges.** `package.json` declares
   `react: "19.1.0"` and `react-native-webview: "13.15.0"` (no caret). On SDK 55 (React **19.2**,
   RNW **13.16.x**) this throws peer-dependency conflicts requiring `overrides` — a concrete,
   additional reason to **crib rather than hard-depend** (sharpens 08's "vendor, don't depend").
   xterm `@^5.5.0` is a *devDependency* used to build the inlined HTML, not a runtime dep (08's
   body said `^5.5.0` correctly; noting it is build-time only).

*(No other corrections. 07/08's core verdicts — no 3rd driver, A/B stand, ghostty-web/Termix/etc.
classifications — reproduced cleanly against primary sources.)*

**Confidence: HIGH.** Every load-bearing claim above is grounded in an npm record, GitHub API
response, or raw source file I read on 2026-05-29.
