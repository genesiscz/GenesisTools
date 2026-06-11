# Terminal parity on mobile via `react-native-webview` wrapping the existing ttyd/xterm web terminal (Expo SDK 55)

**TL;DR**
- **Feasible, low-to-medium risk, and it is the cheapest path** — most of the hard terminal logic (xterm key dispatch, mouse-wheel/touch scrollback, mobile viewport injection) already lives **server-side** in the front-proxy (`src/dev-dashboard/lib/ttyd/mobile-shell.ts`), so a WebView pointed at the same proxied `/ttyd/<id>/` URL inherits it for free. `react-native-webview` (13.16.x, bundled by Expo SDK 55) **does support the New Architecture (Fabric)** — verified by its `codegenConfig` block — so it clears the hard gate.
- **The one feasibility-deciding question is auth, and the repo already answers it favorably:** ttyd WebSockets are gated by a signed **`dd_session` cookie** (not a header), exactly because browser WS handshakes can't carry `Authorization` (`src/dev-dashboard/lib/auth.ts:110-117`). WebView can carry that cookie via `sharedCookiesEnabled`/`thirdPartyCookiesEnabled` — **but iOS WKWebView cookie-sync has documented timing bugs**, so the cookie must be planted (and verified) before the terminal mounts. This is the single biggest risk.
- Real, shipped apps embed xterm-in-WebView terminals today (paseo ~6.9k★, omnara ~2.6k★, suna, myrlin), proving the keyboard/scroll/clipboard bridge pattern works in production. The recommended seam is a `TerminalView` interface (`connect/sendKey/scroll/paste/onData/onStatus`) so a failed WebView approach can be swapped for a native renderer without touching the app.

---

## Context from the existing repo (verified by reading the code)

This matters because it changes the cost calculus dramatically. I read these files in the worktree:

- `src/dev-dashboard/ui/src/components/TtydFrame.tsx` — the web UI mounts `<iframe src="/ttyd/<id>/">` after polling readiness (ttyd binds its port ~100-300ms after spawn, so it probes for HTTP 200 first).
- `src/dev-dashboard/lib/ttyd/mobile-shell.ts` — **the front-proxy injects a mobile shell into the ttyd HTML itself** (matched by `shouldInjectTtydMobileShell(pathname, contentType)` for `/ttyd/<uuid>/` + `text/html`). It rewrites the viewport meta to `width=device-width, ..., viewport-fit=cover` and injects `__ddTtydScroll`, `__ddTtydScrollPage`, touch-scroll handlers, and gesture suppression. It drives scrollback via `term._core.coreMouseService.triggerMouseEvent` (SGR wheel) for tmux alternate-buffer, falling back to `term.scrollLines`.
- `src/dev-dashboard/ui/src/lib/iframe-keys.ts` — special keys (Esc/Tab/arrows/PageUp/PageDown) are sent by resolving `.xterm-helper-textarea` inside the iframe, focusing it, and dispatching a synthetic `KeyboardEvent` (xterm.js does **not** check `event.isTrusted`). Scroll goes via `postMessage` or a direct `__ddTtydScroll` call.
- `src/dev-dashboard/ui/src/components/MobileKeyBar.tsx` — the web key bar positions itself above the OS keyboard using `window.visualViewport` (the web API).
- `src/dev-dashboard/lib/auth.ts:110-229` + `src/dev-dashboard/lib/front-proxy.ts:139-140` — **the auth model.** Every `/ttyd/<id>/*` asset request and **every WebSocket upgrade** is gated by `verifyBasicAuthHeader(authorization) || verifySessionToken(cookie)`. The comment is explicit: *"Browser-initiated WebSocket handshakes cannot carry an Authorization header, so the ttyd terminal + HMR sockets ... are gated by a signed session cookie instead."* Cookie is `dd_session`, `HttpOnly; SameSite=Lax; Path=/`, HMAC-bound to the password material (so `auth reset` invalidates sessions), `Secure` when served over HTTPS.

**Consequence for the WebView port:** the WebView replaces only the `<iframe>` and the *parent-page* helpers. The injected mobile shell, scroll logic, and viewport handling come down the wire from the proxy unchanged. The parent-side key dispatch (`iframe-keys.ts`) and key bar (`MobileKeyBar.tsx`) become, respectively, `webView.injectJavaScript(...)` calls and a **native** `View` of buttons. Injected JS runs *in page context*, so the cross-origin `contentDocument` access that the web iframe relies on (it works only because everything is same-origin behind the proxy) is **no longer a constraint** — WebView is strictly better here.

---

## Per-option evaluation

### Option A (recommended) — `react-native-webview` pointed at the remote proxied ttyd URL (`source={{ uri }}`)

- **Name / repo:** `react-native-webview` — https://github.com/react-native-webview/react-native-webview — **~23k★ (approx, from memory — not re-verified this session)**; community-maintained, was extracted from RN core.
- **Maintenance:** Actively maintained as of **2026-05**. `package.json` on `master` shows **v13.16.1** (latest published 13.16.x line, current as of 2026-05-29); the toolchain is modern (oxlint 1.50, `@typescript/native-preview` / tsgo, semantic-release 25). The npm page states it supports iOS/Android/Windows/macOS and is "compatible with expo." Verified at the raw `package.json` URL on 2026-05-29. (Exact npm publish date of 13.16.1 not separately fetched; SDK 55 bundles 13.16.0, so the line is current within this SDK cycle.)
- **New Architecture (Fabric/TurboModule) support: YES — verified.** Evidence: the `package.json` contains a `codegenConfig` block:
  ```json
  "codegenConfig": {
    "name": "RNCWebViewSpec", "type": "all", "jsSrcsDir": "./src",
    "android": { "javaPackageName": "com.reactnativecommunity.webview" },
    "ios": { "componentProvider": { "RNCWebView": "RNCWebView" },
             "modulesProvider": { "RNCWebViewModule": "RNCWebViewModule" } }
  }
  ```
  `type: "all"` + a `componentProvider` (Fabric native component) + a `modulesProvider` (TurboModule) is the canonical signal of full New-Arch support via Codegen. The npm README also states verbatim: *"This project supports both the old (paper) and the new architecture (fabric)."* (Even a paper-only component would still render via RN 0.83's interop layer, but RNW has genuine Fabric support, so that fallback is moot.)
- **Expo compatibility:** **Bundled with Expo SDK 55** — the SDK 55 docs page (`docs.expo.dev/versions/v55.0.0/sdk/webview/`) lists bundled version **13.16.0** and "Included in Expo Go." Install via `npx expo install react-native-webview`. **Autolinked, no config plugin required.** Works in Expo Go (where available for SDK 55) and in EAS dev-client / prebuild. Since the project already plans dev-client/prebuild, this is a non-issue.
- **Real working example:** This *exact* shape (WebView → **remote** terminal page over WebSocket) is what GenesisTools' own web UI already does behind an iframe; the WebView is a drop-in for the iframe element. For the WebView+xterm+WebSocket pattern specifically, see Option C examples (paseo/omnara) — they bundle the HTML locally rather than loading a remote URL, which is the one meaningful difference (see risk below).
- **Risk verdict: MEDIUM** — feasible and cheap, but the **remote-origin cookie/WebSocket auth** has documented iOS WKWebView edge cases (detailed in the Auth section). Everything else is low-risk.

### Option B — `react-native-webview` loading the proxied ttyd HTML, with the page bundled locally (`source={{ html }}`)

- Same library, same New-Arch/Expo facts as Option A.
- **Difference:** instead of `source={{ uri: "https://host/ttyd/<id>/" }}`, you ship a small local HTML page (`source={{ html }}` or a bundled asset) that loads xterm.js and opens the WebSocket to the remote ttyd directly. This is the **paseo/omnara model**.
- **Why you would do this:** it sidesteps the remote-page cookie-sync problem because the WebSocket is opened by *your* injected JS, so you control auth (put a token in the WS **subprotocol** — see omnara below — or in a query param over `wss://`). It also lets you skip the front-proxy's HTML injection and own the whole xterm config.
- **Why it's *not* the recommended first move here:** it **discards the server-side investment** in `mobile-shell.ts` (scroll, viewport, gesture handling) and re-implements the ttyd↔xterm protocol bridge yourself. ttyd has its own binary WS framing (`auth_token.js` fetch, input/resize frames); replicating it is real work. It only becomes attractive if Option A's remote-cookie path proves unreliable.
- **Risk verdict: MEDIUM** — lower auth risk, higher implementation/maintenance cost (you re-own the ttyd protocol + scrollback logic that the proxy currently gives you).

### Option C — reference apps proving the pattern (not a library choice; evidence)

These are real shipped/starred apps embedding a web terminal in `react-native-webview`. They validate keyboard, scroll, and clipboard bridging end-to-end.

- **paseo** — https://github.com/getpaseo/paseo — **~6.9k★, actively maintained (last commit May 2026).** `packages/app/src/components/terminal-emulator.native.tsx` is a full xterm-in-WebView terminal with a **typed bidirectional bridge** (`BridgeInboundMessage`/`BridgeOutboundMessage`): `writeOutput`, `renderSnapshot`, `focus`, `resize`, `setTheme`, `setScrollback`, `setPendingModifiers` inbound; `input`, `resize`, `terminalKey {key,ctrl,shift,alt,meta}`, `inputModeChange`, `openExternalUrl` outbound. WebView props used: `keyboardDisplayRequiresUserAction={false}`, `originWhitelist={["*"]}`, `scrollEnabled`, `nestedScrollEnabled`, `bounces={false}`, `overScrollMode="never"`, `automaticallyAdjustContentInsets={false}`, `contentInsetAdjustmentBehavior="never"`, `textInteractionEnabled`, `setSupportMultipleWindows={false}`, plus tap-to-focus via `onTouchStart/Move/End` and `webViewRef.current?.requestFocus()`. **This is the single best reference for the swappable native-terminal-in-WebView design.** New-Arch: SDK-level Expo app (uses native tabs, EAS) — runs on current RN. Risk: low (it's the proof).
- **omnara** — https://github.com/omnara-ai/omnara — **~2.6k★ (repo archived Feb 2026, but the code is intact and instructive).** `apps/mobile/src/components/terminal/TerminalMobileTerminal.tsx` loads `xterm@5.3.0` + `xterm-addon-fit` from CDN inside `source={{ html }}`, and **opens the WebSocket from inside the WebView's JS** to a relay (`baseWsUrl`). It **appears to pass the `accessToken` via a WebSocket subprotocol** rather than a header — the init payload carries `accessToken` + a `supabaseSubprotocolPrefix` (`SUBPROTOCOL_PREFIX = 'omnara-supabase.'`), which is the canonical workaround for "browser WebSocket can't set headers." (Inferred from the visible `InitMessagePayload` + prefix constant; the exact `new WebSocket(url, [proto])` line was in the truncated portion of the file.) It uses a binary frame protocol (`FRAME_HEADER_SIZE`, `FRAME_TYPE_OUTPUT`) and posts `status`/`ready`/`error` back via `window.ReactNativeWebView.postMessage`. WebView props: `keyboardDisplayRequiresUserAction={false}`, `hideKeyboardAccessoryView`, `domStorageEnabled`, `mixedContentMode="always"`. This is the direct reference for Option B and for the token-in-subprotocol auth fallback.
- **suna (kortix-ai)** — https://github.com/kortix-ai/suna — `apps/mobile/components/pages/TerminalPage.tsx` uses the same prop set (`keyboardDisplayRequiresUserAction={false}`, `hideKeyboardAccessoryView`, `textInteractionEnabled={false}`, `contentInsetAdjustmentBehavior="never"`, `onMessage`). Confirms the prop recipe is converging across independent teams.
- **myrlin-workbook** — https://github.com/therealarthur/myrlin-workbook — `mobile/components/terminal/TerminalWebView.tsx` with an explicit comment *"Prevent WebView from capturing keyboard events"* on `keyboardDisplayRequiresUserAction={false}`, plus a `bridge.handleWebViewMessage` message handler.

**Honest signal:** every *famous* mobile terminal (Blink, Termius, a-Shell, iSH) is **native**, not WebView-based. There is no flagship "web-terminal-in-WebView" app of that caliber. That's a reportable signal — the WebView approach is common in indie/AI-agent tooling (paseo, omnara, suna) but not in the heavyweight terminal apps, which choose native renderers for latency/keyboard fidelity. It does not block feasibility; it informs the Option-A-vs-native tradeoff (see Performance).

---

## The six sub-topics

### (1) Is `react-native-webview` New-Arch-compatible on SDK 55, and how is it installed under Expo?

- **New Arch: yes (verified via `codegenConfig`, above).** And it's mandatory: the **Expo SDK 55 changelog** (expo.dev/changelog/sdk-55) confirms SDK 55 = RN 0.83 + React 19.2, and that **`newArchEnabled` has been removed from app.json** — "you will not be able to use the Legacy Architecture in SDK 55 projects." So RNW's Fabric support isn't optional polish; it's the only way it runs, and it has it.
- **Install:** `npx expo install react-native-webview` resolves to the SDK-pinned **13.16.0** (per the SDK 55 webview docs page). **Autolinked** (RN ≥0.60 autolinking; SDK 55 also enables `experiments.autolinkingModuleResolution` by default in monorepos). **No config plugin.** No `pod install` step when using CNG/prebuild. EAS dev-client/prebuild is fully supported.

### (2) Loading the remote ttyd page — auth headers / basic-auth / cookies through WebView

**This is the feasibility discriminator, and the repo's auth model makes it workable.**

- The proxy accepts **either** `Authorization: Basic` **or** the `dd_session` cookie for both HTTP assets and the WS upgrade. The cookie is the WS path by design.
- **`source={{ uri, headers }}` custom headers are unreliable and do NOT propagate to the WebSocket handshake** that xterm opens, and often not to sub-navigations either. Documented: react-native-webview #1352 (Android overrides the cookie header), #3535, and the broader community consensus. **Do not rely on a custom `Cookie`/`Authorization` header.** Even if the initial HTML loads 200 via a header, the terminal WS can silently fail to authenticate.
- **Use the cookie path instead.** Plant `dd_session` in the WebView's cookie store *before* mounting the terminal, and the WS handshake (same origin, `SameSite=Lax`) will carry it. Two ways:
  1. **Have the WebView log in first** — navigate to a login/auth-establishing URL on the same origin so the proxy's `Set-Cookie` lands in the WKWebView/Android cookie jar (the proxy already re-applies each `Set-Cookie` across the relay — `front-proxy.ts:291-301`).
  2. **Inject the cookie via a cookie manager** (`@react-native-cookies/cookies` `CookieManager.set(...)`) before render.
- **Required WebView props:** `sharedCookiesEnabled={true}` (iOS — share NSHTTPCookieStorage ↔ WKWebView), `thirdPartyCookiesEnabled={true}` (Android), `domStorageEnabled={true}`.
- **iOS caveat (the real risk):** WKWebView cookie sync is **timing-unreliable** — documented in react-native-webview #1780 ("NS/WK cookies unreliably synced"), #3344 ("cookies not being sent to webview for iOS" after RN 0.73+), #1350 (cookies not shared across WebViews on iOS). Mitigation: set the cookie via `CookieManager` and **wait for the set to resolve**, then mount the WebView with a `key` that forces a fresh instance; verify the session by probing `/ttyd/<id>/` for 200 (the same readiness probe `TtydFrame.tsx` already does) before treating the terminal as live. If cookie sync proves flaky in practice, fall back to **Option B** (open the WS yourself with the token in the subprotocol, omnara-style) — `SameSite=Lax` + `Secure` over `wss://` is the secure shape.
- **`SameSite=Lax` is fine here** because the WebView loads the cookie's own origin (first-party). It would only bite if the terminal were embedded cross-site.

### (3) Keyboard handling — software keyboard, hardware keyboard, special keys, paste

- **Raise the software keyboard:** `keyboardDisplayRequiresUserAction={false}` is **the single most-missed prop** for this use case. Without it, programmatically focusing `.xterm-helper-textarea` on iOS will *not* show the keyboard. Confirmed by paseo, omnara, suna, myrlin, and the react-native-webview type docs. Add `hideKeyboardAccessoryView` to drop the iOS input-accessory bar (paseo/omnara/suna do).
- **Focus:** tap-to-focus via `onTouchStart/Move/End` on the WebView + `webViewRef.current?.requestFocus()` then inject `document.querySelector('.xterm-helper-textarea').focus()` (paseo's exact pattern). This replaces the parent-page focus in `iframe-keys.ts`.
- **Special keys (Esc/Ctrl/Tab/arrows):** port `dispatchKey()` from `iframe-keys.ts` **verbatim** into an injected-JS string. Because injected JS runs in page context, it can reach `.xterm-helper-textarea` directly (no cross-origin issue) and dispatch the synthetic `KeyboardEvent` (xterm doesn't check `isTrusted`). Example shape:
  ```js
  webView.injectJavaScript(`
    (function(){
      var t = document.querySelector('.xterm-helper-textarea');
      if(!t) return;
      t.focus();
      t.dispatchEvent(new KeyboardEvent('keydown',
        {key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true}));
    })(); true;`);
  ```
  Extend the key table (already in `iframe-keys.ts`) with **Ctrl combos** (Ctrl+C/D/Z/L) by setting `ctrlKey:true` + the letter — or, more robustly for control chars, write the raw control byte to the terminal (`term.paste('\x03')` / inject into the WS). A **native** key bar (RN `View` of `Pressable`s) replaces `MobileKeyBar.tsx`; it no longer needs `window.visualViewport` math — RN's `Keyboard` events + `useSafeAreaInsets()` give you the keyboard height and insets natively.
- **Hardware keyboard:** physical keys go straight to the focused textarea inside the WebView — xterm handles them as on the web. The only friction is OS-level shortcut interception; generally works once the textarea has focus.
- **Paste (into terminal):** `injectJavaScript("window.term && window.term.paste(" + JSON.stringify(text) + "); true;")` — read the native clipboard with `expo-clipboard` (`Clipboard.getStringAsync()`) and inject. Avoid string-concatenating untrusted text; `JSON.stringify` to escape.
- **Copy (out of terminal):** inject `window.term.getSelection()` and post it back via `window.ReactNativeWebView.postMessage(JSON.stringify({type:'selection', text}))`, handle in `onMessage`, then `Clipboard.setStringAsync(text)`. This page→native channel is first-class (`react-native-webview` `WebViewTypes.ts` documents `onMessage` ↔ `window.ReactNativeWebView.postMessage`; used by Expo's own DOM components and dozens of apps).
- **IME / autocorrect gotcha:** mobile keyboards can inject autocapitalization/autocorrect/composition into the xterm textarea, corrupting input. Mitigate by injecting `autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false"` onto the helper textarea after load (and consider `inputmode`), since the OS keyboard overrides ttyd's defaults.

### (4) Scrollback + viewport + safe-area

- **Scrollback:** **already solved server-side.** `mobile-shell.ts` injects `__ddTtydScroll`/`__ddTtydScrollPage` (SGR mouse-wheel for tmux alt-buffer, `scrollLines` fallback) and a touch-scroll handler bound to `.xterm`. In the WebView these all ship down with the HTML, so touch-drag scrollback works without any RN code. The native key bar's PgUp/PgDn just `injectJavaScript("window.__ddTtydScrollPage(-1)")`.
- **Viewport:** the proxy rewrites the viewport meta to `viewport-fit=cover` + `user-scalable=no` (`mobile-shell.ts`). Pair with `setBuiltInZoomControls={false}`, `setDisplayZoomControls={false}`, `textZoom={100}` (paseo) so the page doesn't pinch-zoom.
- **Sizing / no double scroll:** `scrollEnabled` + `bounces={false}` + `overScrollMode="never"` + `automaticallyAdjustContentInsets={false}` + `contentInsetAdjustmentBehavior="never"` (paseo/suna recipe) so the WebView's own scroll container doesn't fight xterm's `.xterm-viewport`.
- **Safe area / keyboard avoidance:** SDK 55 makes edge-to-edge mandatory on Android and adds default safe-area handling in native-tabs layouts. Use `react-native-safe-area-context` `useSafeAreaInsets()` to pad the terminal container and to position the native key bar above the home indicator. For keyboard avoidance, listen to RN `Keyboard` events (`keyboardDidShow`/`Hide`) to resize the terminal container and keep the key bar pinned above the keyboard — this is the native replacement for the `visualViewport` logic in `MobileKeyBar.tsx`. After resize, send `__ddTtydScroll`/fit by injecting a resize so xterm reflows (or rely on ttyd's own fit-on-resize).

### (5) WebSocket stability inside WebView + reconnection

- **Stability:** the WebSocket runs inside the WebView's own browser engine (WKWebView / Android System WebView), exactly like the web app's iframe — so it's as stable as ttyd-in-a-browser is today. No RN-side WS bridge is involved for Option A. The known failure modes are WebView lifecycle events, not WS-protocol issues:
  - iOS **`onContentProcessDidTerminate`** (WKWebView content process killed under memory pressure → blank WebView) and Android **`onRenderProcessGone`** — paseo handles both explicitly and remounts via a `webViewEpoch` key. **You must handle these**, or a backgrounded terminal comes back blank.
  - Backgrounding: iOS may suspend the WebView; the WS drops. ttyd supports client reconnect (`-r`/`--reconnect`), and tmux/cmux means the session **survives** server-side — reattach restores state. So reconnection is "remount the WebView and let it reattach," which is cheap.
- **Reconnection strategy:** reuse the existing `TtydFrame` readiness probe (poll `/ttyd/<id>/` for 200, retry ~600ms × 30) before remount, so the user never sees a 502 from the front-proxy racing ttyd's port bind. On `AppState` `active`, re-probe and, if the WS is dead, bump the WebView `key` to force a clean reattach. Because the cookie persists in the WebView jar, reattach doesn't re-auth (subject to the iOS cookie-sync caveat in §2).

### (6) Performance vs a native approach

- **WebView (Option A/B):** input→render latency is whatever ttyd-in-a-browser already is — acceptable for interactive shells, TUIs, and tmux. xterm.js with the canvas/WebGL renderer is fast enough for typical dev workloads. The cost is a full WebView instance (memory, a content process that iOS can reclaim) and a slightly heavier keypress path (RN → injectJavaScript → JS dispatch → WS). For a *single* terminal pane this is negligible.
- **Native (e.g. SwiftTerm/native xterm renderer):** lower latency, better hardware-keyboard fidelity, no content-process-termination class of bugs — which is exactly why Blink/Termius/a-Shell go native. But it's **far more work**, throws away 100% of the server-side `mobile-shell.ts`/proxy investment, and needs its own ttyd-protocol client.
- **Verdict:** for parity-with-the-web-dashboard at minimal cost, WebView wins. The performance ceiling only matters if you later target many simultaneous panes or want sub-frame keystroke latency — and the swappable interface (below) lets you migrate to native then without an app rewrite.

---

## Swappable-interface design (required by the task)

Commit the recommendation behind a single seam so a failed approach is replaceable:

```ts
export interface TerminalView {
  connect(sessionId: string): void;          // mount/point at /ttyd/<id>/ (or open WS)
  disconnect(): void;
  sendKey(key: TerminalKey): void;            // Esc/Tab/arrows/Ctrl-combos (ports iframe-keys.ts)
  sendText(text: string): void;               // typed/pasted text
  scroll(lines: number): void;                // -> __ddTtydScroll
  scrollPage(direction: -1 | 1): void;        // -> __ddTtydScrollPage
  paste(text: string): void;                  // clipboard -> term.paste
  focus(): void;
  // events out:
  onData?(chunk: string): void;               // optional, for native renderers
  onSelection?(text: string): void;           // copy-out
  onStatus?(s: TerminalStatus): void;         // connecting/connected/disconnected/error
}
```

Three implementations satisfy it without touching callers:
- `WebViewTtydTerminal` (Option A) — `source={{uri}}`, injectJavaScript for keys/scroll, `onMessage` for selection/status.
- `WebViewXtermTerminal` (Option B) — local HTML + own WS (omnara model), token in subprotocol.
- `NativeTerminal` (future) — SwiftTerm/native xterm, own ttyd client.

paseo's `TerminalEmulatorHandle` (`writeOutput`/`renderSnapshot`/`focus`/`blur` via `useImperativeHandle`) is a proven concrete shape to model this on.

---

## Recommendation

**Build Option A first: `react-native-webview` (autolinked, SDK-55-bundled 13.16.0, New-Arch-verified) pointed at the remote `/ttyd/<id>/` URL, behind a `TerminalView` interface.** It clears the mandatory New-Architecture gate, requires no config plugin, and reuses the entire server-side mobile shell — keys, scrollback, viewport, and gesture handling already arrive in the HTML. The parent-page logic ports directly: `iframe-keys.ts`'s `dispatchKey` becomes an injected-JS string (and gets *easier* because injected JS isn't cross-origin-restricted), and `MobileKeyBar.tsx` becomes a native button bar driven by RN `Keyboard`/safe-area instead of `visualViewport`.

**Required prop recipe** (converged across paseo/omnara/suna/myrlin): `keyboardDisplayRequiresUserAction={false}`, `hideKeyboardAccessoryView`, `sharedCookiesEnabled`, `thirdPartyCookiesEnabled`, `domStorageEnabled`, `originWhitelist={["*"]}` (or scoped to the dashboard origin), `bounces={false}`, `overScrollMode="never"`, `automaticallyAdjustContentInsets={false}`, `contentInsetAdjustmentBehavior="never"`, `setBuiltInZoomControls={false}`, `setDisplayZoomControls={false}`. Handle `onContentProcessDidTerminate` (iOS) and `onRenderProcessGone` (Android) by remounting via a `key`.

**Main risks, in priority order:**
1. **iOS WKWebView cookie sync (medium).** The `dd_session` cookie must reach the WS handshake; iOS cookie sync is documented as timing-unreliable (#1780/#3344/#1350). Plant the cookie with `@react-native-cookies/cookies`, await it, force a fresh WebView, and re-probe `/ttyd/<id>/` for 200 before going live. If still flaky → fall back to **Option B** (own the WS, token in subprotocol over `wss://`).
2. **WebView content-process termination (low-medium).** Backgrounded terminals can come back blank; the remount-on-`onContentProcessDidTerminate`/`onRenderProcessGone` handler is mandatory. tmux/cmux makes reattach cheap and stateful.
3. **IME/autocorrect corrupting input (low).** Force `autocapitalize/autocorrect/autocomplete=off`, `spellcheck=false` on the helper textarea after load.
4. **No flagship precedent (informational).** Heavyweight terminal apps go native; the WebView pattern is proven in indie/agent tooling (paseo 6.9k★, omnara 2.6k★) but not in Blink/Termius-tier apps. The `TerminalView` seam keeps a native migration open if latency/fidelity ever demands it.

Confidence is **high** on the New-Arch/Expo/version facts (verified against the library `package.json` and the official SDK 55 docs/changelog) and on the auth model (read directly from the repo). Confidence is **medium** on the iOS cookie-sync behavior in *this specific* deployment — it's well-documented as a class of bug, but the exact reliability depends on HTTPS/origin/timing and should be verified on-device early.
