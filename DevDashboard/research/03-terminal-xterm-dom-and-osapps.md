# 03 — Terminal rendering on RN/Expo: xterm.js via DOM components vs raw WebView, + lessons from shipped mobile terminals

**TL;DR**
- **Verdict: raw `react-native-webview` (point it at the existing ttyd URL) beats Expo DOM components for our ttyd case.** Expo DOM components are *themselves* a webview wrapper, but they are designed to host *your bundled web code* and an async/serialized prop bridge — they have no "navigate to a remote origin" mode. ttyd serves its own remote HTML+WebSocket page, so `<WebView source={{ uri: "/ttyd/<id>/" }}/>` is the near-drop-in heir to today's `<iframe>`; DOM only competes on the much heavier "reimplement the xterm.js client ourselves and speak ttyd's WS framing directly" path.
- **Hard gate passes, but with one current, live caveat.** `react-native-webview` officially supports the New Architecture (Fabric) and is bundled by Expo SDK 55. BUT there is an **open, unmerged bug (#3863)** where the iOS `source` prop does not propagate under Fabric on RN 0.81–0.83 — confirmed on RN 0.83.1 (SDK 55) as recently as 2026-03-21, with the community fix PR closed-stale unmerged. The verified workaround is **set `source` imperatively via a ref / remount with `key`**. This is a risk to plan around, not a blocker.
- **Shipped mobile terminals split cleanly into two camps, and both are precedent for us.** Web-terminal-in-a-webview is proven premium-grade (Blink Shell ships Chromium's *hterm* in a webview — verified from their README; a-Shell appears to use an hterm-style web renderer too, medium-confidence). Native VT renderers (SwiftTerm → Secure ShellFish / La Terminal / CodeEdit; libghostty → RootShell/Moshi; Panic's Prompt 3 "100% native") win on extreme scroll/`nvim`/`tmux` smoothness but throw away our xterm/ttyd reuse entirely. For our reuse-driven, swap-behind-an-interface goal, the webview camp is the right starting point — keep native as the documented escape hatch.

---

## Context: what we are actually replacing

Today the dev-dashboard web UI embeds ttyd in a **same-origin `<iframe>`** (`TtydFrame.tsx` → `<iframe src="/ttyd/<id>/">`). Two pieces of glue make mobile work:

1. **Server-side HTML injection** (`src/dev-dashboard/lib/ttyd/mobile-shell.ts`): the front-proxy rewrites ttyd's HTML to inject a mobile viewport meta, mobile CSS, touch-drag→scrollback handling, and `window.__ddTtydScroll(...)` helpers. **This is transport-agnostic** — it rewrites the page ttyd serves, regardless of whether a browser iframe or an RN WebView loads that URL. It ports to the WebView path *unchanged*.
2. **Parent→iframe key bridge** (`src/dev-dashboard/ui/src/lib/iframe-keys.ts`): the parent page reaches into `iframe.contentDocument`, focuses `.xterm-helper-textarea`, and dispatches synthetic `KeyboardEvent`s; scroll goes via `postMessage`. **This does NOT port to RN.** A WebView has no parent DOM — the parent is native. The synchronous "focus + dispatch synthetic KeyboardEvent" trick is replaced by `webView.injectJavaScript("…")` (RN→web) and `window.ReactNativeWebView.postMessage` / `onMessage` (web→RN).

That asymmetry — server injection reuses, key bridge rewrites — is the single biggest practical input to the verdict, and it favors the WebView path because the *expensive* reusable asset (the proxy injection) survives.

---

# Angle A — Expo DOM components vs raw `react-native-webview`

## Option A1 — Raw `react-native-webview` → ttyd URL (the iframe heir)

- **Package / repo:** `react-native-webview` — https://github.com/react-native-webview/react-native-webview — ~7.2k stars, ~3.2k forks.
- **Maintenance:** Active. Latest npm `13.16.1` published **2026-02-27** (alongside SDK 55 GA); previous `13.16.0` 2025-08-25. README states it is the actively-merged community fork ("nearly 500 PRs merged… we will prioritize reviewing and merging PRs"). Not archived. *Caveat (verified):* maintainer throughput is low — see the New-Arch bug below where a working fix sat unmerged for months and was auto-closed as stale.
- **New Architecture (Fabric):** **YES (verified)** — npm + GitHub README explicitly: "This project supports both the old (paper) and the new architecture (fabric)." Fabric support landed in PR #2686 ("feat: Fabric support"). **BUT a live caveat:** iOS issue #3863 — under Fabric the `source` prop is not pushed to native (`updateProps` not called → blank webview), reproduced on iOS for RN 0.77–0.81 and **confirmed on RN 0.83.1 (= SDK 55) on 2026-03-21** by Hector-Zhuang; "I suspect this bug affects any iOS project with Fabric enabled." Community fix PR #3880 worked (confirmed on Expo 55 by `kulek1` 2026-01-25) but was **closed-stale, never merged** (2026-03-26); people still hit it on 2026-04-15. **Workaround (verified, `o-alexandrov` 2026-01-16): "set `source` using `ref`"** — i.e. assign source imperatively / remount the WebView with a changing `key` rather than relying on a prop update. Android is unaffected.
- **Expo compatibility:** First-class. Listed in Expo SDK 55 docs (`https://docs.expo.dev/versions/v55.0.0/sdk/webview`); supports `source={{ uri }}` and `source={{ html }}`; **works in Expo Go**, no config plugin needed, no prebuild needed for basic use. (We will run dev-client/prebuild anyway, which only widens what's allowed.)
- **Real working example:** Itself is the substrate of essentially every RN SSH/terminal client that renders xterm/hterm. Concrete xterm-specific reference: **`@fressh/react-native-xtermjs-webview`** (EthanShoeDev/fressh, https://github.com/EthanShoeDev/fressh) wraps `@xterm/xterm` in `react-native-webview` with exactly a `write/writeMany/flush/clear/focus/resize/fit` handle + `onData` callback — see A-shared "Reference interface" below. Also note WebView's own `docs/Guide.md` documents the `onMessage` + `window.ReactNativeWebView.postMessage` bridge and `injectedJavaScript`/`injectJavaScript`.
- **Risk verdict: MEDIUM** — the technology is the obvious, proven fit and reuses our proxy injection wholesale; rated medium (not low) only because of the open, currently-reproducing Fabric `source` bug on iOS RN 0.83.1/SDK 55, which has a known ref/remount workaround and which we can pin/patch (`patch-package`) until upstream merges. Absent that bug it would be low.

**Why it fits ttyd specifically:** ttyd is a *remote URL serving its own xterm.js client over a WebSocket*. `<WebView source={{ uri: "https://<dashboard>/ttyd/<id>/" }}/>` makes the WebView do precisely what the browser iframe does today — load that page, run ttyd's bundled xterm client, open the WS. Our existing `mobile-shell.ts` injection still fires (it keys off the `/ttyd/<uuid>/` path + `text/html` content-type at the proxy). The mobile-specific work shrinks to: a native key bar that calls `injectJavaScript`, and reading `onMessage` for any web→native signals.

## Option A2 — Expo DOM components (`'use dom'` / `@expo/dom`)

- **Package / repo:** Built into Expo (`expo/dom`), first-party. Docs: `https://docs.expo.dev/versions/v55.0.0/sdk/...` and the `expo:use-dom` skill.
- **Maintenance:** Active, first-party Expo feature, current in SDK 55.
- **New Architecture (Fabric):** **YES (implied, first-party).** DOM components render through Expo's own webview host, which is New-Arch-native in SDK 55. (Note: under the hood DOM components still rely on the same WKWebView/Android WebView substrate as `react-native-webview`; whether they share the exact #3863 code path is unverified, but DOM components load *bundled* content rather than navigating to a remote `source` URL, so the specific `source`-prop bug is structurally unlikely to apply to them.)
- **Expo compatibility:** Expo-only by definition; needs the Metro web bundler. Works in dev-client/prebuild. Web target renders the same code with no webview wrapper (a nice bonus for our existing web dashboard, but irrelevant on native).
- **The disqualifying architectural fact (verified against the `expo:use-dom` skill):** A DOM component **runs your bundled web code in a webview**; props must be **serializable** (strings/numbers/booleans/arrays/plain objects), native capabilities are exposed as **`async` functions** marshalled across the bridge, and "the webview has its own JavaScript context — cannot directly share state with native." There is **no API to point a DOM component at a remote URL.** The skill even lists "iframes or embeds — embedding external content that requires a browser context" as a use case, i.e. the DOM-component path to ttyd would be **DOM component → an `<iframe src="/ttyd/<id>/">` inside it**, which is strictly *more* layers than a plain WebView pointed at the same URL, for no gain.
- **The only non-silly DOM path:** reimplement the xterm.js terminal client *as* the DOM component (`import { Terminal } from '@xterm/xterm'` inside a `'use dom'` file) and connect it **directly to ttyd's WebSocket**, bypassing ttyd's own HTML client. This buys an ergonomic typed async bridge (`write`, `onData` as proxied async props instead of hand-rolled `injectJavaScript`/`onMessage` string plumbing) and an isomorphic web build — **but** it (a) discards ttyd's served client and forces us to own ttyd's WebSocket subprotocol/framing, (b) loses our `mobile-shell.ts` proxy injection (there's no served HTML to rewrite — we'd reimplement that CSS/touch logic inside the DOM component), and (c) the async-only bridge means **no synchronous focus+synthetic-KeyboardEvent** path like today's `iframe-keys.ts`; every keystroke is an async marshalled call (fine for a key-bar tap, awkward for high-throughput).
- **Real working example:** DOM components have shipped real apps (Expo's own demos: charts, syntax highlighters, rich text). I found **no** shipped example of a *terminal* built as an Expo DOM component talking to ttyd/WebSocket — so the terminal-specific path is **unproven** (claimed-feasible, not verified-in-the-wild).
- **Risk verdict: HIGH** — not because DOM components are bad (they're great for hosting bundled web UI), but because for *ttyd* they force a client rewrite + WS-protocol ownership + loss of proxy reuse, with no in-the-wild precedent. High effort, higher unknowns, no offsetting win over A1 for this specific case.

## A-shared — xterm.js addons on mobile webviews (applies to both A1 and A2)

Current package names are **`@xterm/xterm` (v5)** with scoped addons `@xterm/addon-fit`, `@xterm/addon-webgl`, `@xterm/addon-attach`, `@xterm/addon-clipboard` (the old `xterm` / `xterm-addon-*` names are deprecated aliases; ttyd's bundled client and zellij's web client both use these). Mobile-webview reality per addon:

- **`addon-fit`** — fits cols/rows to the container. **Safe and essential** on mobile. Pair with a `resize` observer and re-`fit()` on rotation / keyboard show-hide. (zellij ships `addon-fit.js`; fressh exposes `fit()` on its handle.)
- **`addon-webgl`** — WebGL2 renderer. **Flag: do NOT default this on iOS.** Verified history of WebGL flakiness in WKWebView (Apple Dev Forums threads 102479 / 103883 "WKWebView WebGL not working… CANVAS works fine"; iOS-15 GPU-process-canvas perf regression, apache/cordova-ios #1246) and xterm-specific breakage (xterm.js #3357 "WebGL rendering broken on Safari", missing glyphs). xterm's webgl addon can also drop the GL context (`webglcontextlost`) under memory pressure / app suspension — common on mobile — requiring fallback handling. **Default to xterm's DOM renderer** (no addon) on iOS; consider canvas/webgl only behind a per-platform flag after measuring. (Note: today we don't control ttyd's renderer choice on the A1 path — ttyd picks it — so this mostly matters for A2 or if we configure ttyd.)
- **`addon-attach`** — wires xterm straight to a WebSocket. Relevant **only on the A2 "rebuild the client" path**; on A1, ttyd's own client already owns the WS. Don't pull it in for A1.
- **`addon-clipboard`** — OSC-52 clipboard. Works in webviews but mobile clipboard UX is the weak spot of the whole approach (see Angle B). Plan native copy/paste affordances (selection handles, a "paste" key-bar button calling `injectJavaScript` to write into the terminal) rather than relying on webview text selection alone.

**Reference interface (verified, from `@fressh/react-native-xtermjs-webview`, `packages/react-native-xtermjs-webview/src/index.tsx`):** a real RN+xterm webview wrapper exposes this imperative handle —

```ts
type XtermWebViewHandle = {
  write: (data: Uint8Array) => void;       // bytes in (batched)
  writeMany: (chunks: Uint8Array[]) => void; // many chunks in one postMessage (initial replay)
  flush: () => void;                        // force-flush outgoing writes
  clear: () => void;
  focus: () => void;
  resize: (size: { cols: number; rows: number }) => void;
  fit: () => void;
};
// + callbacks: onData(data: string), onInitialized()
```

It implements RN→web as `webView.injectJavaScript("window.dispatchEvent(new MessageEvent('message',{data:…}))")`, web→RN via `onMessage`, batches writes behind an **rAF + 8KB coalescer** (don't postMessage per byte — terminals are chatty), and crucially wires `onContentProcessDidTerminate` (iOS WebView crash) and `onRenderProcessGone` (Android WebView crash) so a crashed long-lived terminal can be detected and reloaded. (Repo is small — 12 stars, last commit 2025-09 — so treat it as a *pattern source*, not a dependency to ship.)

---

# Angle B — How shipped mobile terminals render, and the design patterns to steal

Split by what is **verifiable from source/official docs** vs **closed/claimed**.

## Blink Shell (iOS) — web terminal in a webview *(verified)*
- Repo: https://github.com/blinksh/blink (open source; ~6k+ stars). App Store: "Blink Shell, Build & Code".
- **Rendering: Chromium's `hterm` (HTML terminal) inside a webview.** Verified from their own README/docs.blink.sh: *"We simply used Chromium's HTerm to ensure that rendering is perfect and fast, even with those special, tricky encodings."* This is the **headline precedent**: a paid, professional, "desktop-grade" iOS terminal renders in a webview — proof the approach is viable at premium quality.
- **Known limit:** issue #794 "Replace Webview with native renderer" — power users on iPad doing heavy dev want native. So webview is good-enough-to-ship-premium, but the extreme `nvim`/`tmux`-at-120Hz tier is where webview shows its seams.
- **Pattern to steal:** invest in input/keyboard handling and a hardware-keyboard story; Blink's reputation is built on keyboard config, not on the renderer being native.

## a-Shell (iOS) — native shell, hterm-style webview renderer *(repo verified; renderer detail medium-confidence)*
- Repo: https://github.com/holzschu/a-shell (open source). Uses `ios_system` for command execution (native, WASM-based commands), multi-window via iPadOS.
- **Rendering:** terminal *view* is an hterm-derived web terminal in a WKWebView (holzschu's stack is hterm-based); command *execution* is native. I verified the native-execution architecture from the repo; the hterm-in-webview rendering detail is consistent with the project's lineage but I did not open the view source — mark **medium confidence**.
- **Pattern to steal:** clean split of *renderer* (web) from *backend* (native) — exactly our ttyd-is-the-backend / webview-is-the-renderer split.

## Secure ShellFish, La Terminal, CodeEdit — native SwiftTerm *(verified)*
- SwiftTerm: https://github.com/migueldeicaza/SwiftTerm — VT100/Xterm emulator in Swift. README (verified): *"used in several commercially available SSH clients, including Secure Shellfish, La Terminal and CodeEdit."*
- **Rendering: fully native** UIKit/AppKit text rendering, no webview.
- **Pattern to steal (input/UX, not renderer):** `SwiftTerm/Sources/SwiftTerm/iOS/iOSTerminalView.swift` is a reference implementation of mobile terminal text-input handling (custom `UIKeyInput`/text-input, accessory key bar, selection). Even staying webview, the *interaction* patterns (accessory key row above the keyboard, long-press selection handles, modifier-key sticky keys) are worth mirroring. Our `MobileKeyBar.tsx` is the start of this.

## Panic's Prompt 3 (iOS/macOS) — native *(verified claim)*
- panic.com/prompt: *"100% native app."* Closed source. Rendering tech = native (their marketing explicitly contrasts native speed vs JS-wrapped terminals).
- **Pattern to steal:** the *bottom accessory toolbar* of context keys (Esc, Ctrl, Tab, arrows, `|`, `-`, `~`, `/`) is the de-facto iOS terminal convention — match its key set, not just Esc/Tab/arrows.

## RootShell / Moshi (iPad) — libghostty native *(verified, recent)*
- Reddit r/ipad (2026): a new iPad terminal on **libghostty**; the dev's own comment: *"I ran into the same lag issue with the JS-wrapped terminals, which is why I ended up building Moshi on libghostty… Native rendering makes a huge difference once you actually start using nvim or tmux on iPad."*
- **Why it matters for us (honest counter-evidence):** a current, credible practitioner says JS/webview terminals lag specifically under `nvim`/`tmux` heavy redraw — which is *exactly our tmux/cmux use case*. This is the strongest argument for keeping a native escape hatch behind the interface. It is not a reason to start native: our reuse (ttyd + proxy injection) and swappability goal both point at webview-first, measure, and only go native if redraw latency proves unacceptable on target devices.

## Termius (iOS/Android, RN-ish?) and "Touch Terminal" — *closed / claimed-unknown*
- Termius blog "New Touch Terminal on iOS" talks about a *native-iOS-feeling* redesign of the on-screen interaction, but does **not** state the underlying renderer. **Rendering tech: unknown/claimed.** Do not assert it's native or web.
- General: Termius is cross-platform (iOS/Android/desktop) which historically correlates with a shared web/Electron-ish core, but I found no primary source confirming the mobile renderer — leave unverified.

## Termux (Android) — native `TerminalView` *(known/claimed)*
- Termux renders via its own native Android `TerminalView` (custom `View` drawing a VT emulator), not a webview. Widely documented in the ecosystem; I did not open termux-app source this pass — mark **claimed/known**, not freshly verified. Relevant only as "the Android-native bar is high"; not a path we'd take given our reuse goals.

## Distilled, reusable design patterns (apply regardless of renderer)
1. **Renderer ≠ backend.** Every good design separates the VT emulator/renderer from the byte source. Our ttyd = backend; the WebView (or DOM component, or future native view) = renderer. Lock this with an interface (below).
2. **Bottom accessory key bar is mandatory and richer than arrows.** Match Prompt/Blink: Esc, Tab, Ctrl (sticky modifier), Alt/Meta, arrows, and common punctuation (`| - ~ / : *`). We already have `MobileKeyBar.tsx` with Esc/Tab/arrows/PgUp/PgDn — extend it with a sticky **Ctrl** modifier (the single most-missed key) and common symbols.
3. **Sticky/one-shot modifiers** (tap Ctrl, then a letter → Ctrl-C) beat trying to chord on a touchscreen. SwiftTerm's iOS view implements this; mirror it.
4. **Keep the soft keyboard from stealing focus** when tapping the key bar — we already do this (`onPointerDown` + `preventDefault` in `MobileKeyBar`). Preserve it across the WebView boundary (the key bar is native; it must `injectJavaScript` without blurring the WebView's hidden textarea, or re-focus after).
5. **Touch gestures:** one-finger drag = scrollback (we already translate drag→wheel/`scrollLines` in `mobile-shell.ts`); pinch/zoom must be disabled (we do, via viewport + `gesture*` preventDefault); reserve two-finger or edge gestures for app chrome, not the terminal.
6. **Scrollback in tmux alternate buffer is special** — `scrollLines` is a no-op in the alt buffer; real wheel events (SGR mouse) are required. We already handle this (`scrollViaMouseWheel` + `coreMouseService.triggerMouseEvent`). This logic is in the *injected page script*, so it survives the move to WebView only on the A1 path; on A2 we'd re-port it.
7. **Hardware keyboard:** WebView forwards real HW-keyboard events to the page's xterm automatically (it's a real key event in the web context) — a major reason the webview path is low-effort for HW-keyboard parity. Native renderers must hand-roll this.
8. **Coalesce writes; expect crashes.** Batch terminal output (rAF + ~8KB) before crossing the bridge; wire iOS `onContentProcessDidTerminate` / Android `onRenderProcessGone` to detect and auto-reload a dead WebView (per fressh).
9. **Copy/paste is the webview weak spot.** Provide explicit affordances: a "Paste" key-bar button (`injectJavaScript` to write clipboard text into the terminal) and selection handles, rather than relying on default webview text selection.

---

# Recommendation

**Adopt Option A1 — `react-native-webview` pointed at the existing ttyd URL — as the v1 renderer, behind a swappable `TerminalSurface` interface. Reject DOM components for ttyd. Document native (SwiftTerm/libghostty via an Expo module) as the pre-designed escape hatch.**

**Why A1 over A2 (DOM):** the comparison only *looked* like "two rival webview techs." It isn't. DOM components host *bundled* web code with an async/serialized bridge and cannot navigate to a remote origin; ttyd *is* a remote origin. So A1 is a near-drop-in for today's iframe (reuses `mobile-shell.ts` proxy injection unchanged, gets HW-keyboard parity for free, and ttyd keeps owning its own WS), while A2 forces us to rewrite the xterm client, own ttyd's WebSocket framing, and re-port all the mobile CSS/touch/scrollback logic — for an ergonomic-bridge benefit we don't need and with zero in-the-wild precedent.

**Define the swap interface** (so any failed renderer is replaceable without touching the app — synthesized from fressh's verified handle plus our existing key/scroll glue):

```ts
export interface TerminalSurface {
  // lifecycle
  mount(opts: { sessionUrl: string; cols?: number; rows?: number }): void;
  dispose(): void;
  onReady(cb: () => void): void;
  onExit(cb: (reason: "crash" | "closed") => void): void; // maps to onContentProcessDidTerminate / onRenderProcessGone

  // I/O — for A1 (ttyd owns the WS) write/onData are mostly unused;
  // they become primary on A2/native where we own the byte stream
  write(data: Uint8Array): void;
  onData(cb: (chunk: string) => void): void;

  // interaction (the part that always matters on mobile)
  focus(): void;
  sendKey(key: TerminalKey, mods?: { ctrl?: boolean; alt?: boolean; shift?: boolean }): void;
  scroll(lines: number): void;        // +down / -up
  scrollPage(dir: -1 | 1): void;
  resize(size: { cols: number; rows: number }): void;
  fit(): void;
  paste(text: string): void;
}
```

- **`WebViewTerminalSurface` (A1, ship first):** `<WebView source={{ uri }}/>`; `sendKey`/`scroll`/`paste`/`fit` implemented via `injectJavaScript` (reusing the already-injected `window.__ddTtydScroll` helpers and a new `window.__ddTtydKey` helper added to `mobile-shell.ts`); `onData`/`onExit` via `onMessage` + the crash callbacks. The native `MobileKeyBar` (lift the existing one to RN) calls `surface.sendKey(...)`.
- **`DomTerminalSurface` (A2, do NOT build now):** only if we ever want the isomorphic-web bridge; documented as possible, not planned.
- **`NativeTerminalSurface` (escape hatch):** an Expo module wrapping SwiftTerm (iOS) / a libghostty or native VT view (Android), fed by a native WebSocket to ttyd's PTY stream. Build *only if* measured redraw latency under `nvim`/`tmux` on target devices is unacceptable — the RootShell/Moshi developer's lag complaint is the trigger condition.

**Plan around the live risks (all verified):**
1. **iOS Fabric `source` bug (#3863, open on RN 0.83.1 / SDK 55):** set `source` imperatively via ref or remount the WebView with a changing `key`; if blank-webview reproduces, vendor PR #3880 via `patch-package` until upstream merges. Test this on a real iOS device early — it's the one thing that can blank the terminal on SDK 55.
2. **WebGL on iOS:** keep xterm on the **DOM renderer** on iOS (don't enable `@xterm/addon-webgl`); revisit only behind a measured per-platform flag.
3. **Long-lived WebView crashes:** wire `onContentProcessDidTerminate` (iOS) / `onRenderProcessGone` (Android) → auto-reload + reconnect.
4. **Copy/paste & Ctrl key:** add a sticky-Ctrl modifier and a Paste button to the key bar; don't rely on default webview selection.

**Confidence:** High on the verdict (DOM-vs-WebView discriminator verified against the `expo:use-dom` skill + SDK 55 docs; New-Arch support and the #3863 caveat verified from primary sources; the webview-terminal precedent verified from Blink's own README and fressh's source). Medium only on a-Shell's exact renderer and Termux/Termius internals, which are marked accordingly and do not affect the recommendation.
