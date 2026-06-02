# 06 — Terminal Approach: Adversarial Verification + Recommendation

> Synthesis of reports 01 (WebView+ttyd), 02 (native emulators), 03 (xterm-via-DOM vs WebView).
> Every load-bearing claim below was re-checked against the actual npm registry, package tarballs,
> and GitHub issues/PRs on **2026-05-29**. Claims I could not independently confirm are marked
> *(claimed, not re-verified here)*.

---

## ┌─ VERDICT ─────────────────────────────────────────────────────────────┐

**PICK: react-native-webview pointed at the existing ttyd URL** (report 01 Option A / report 03 A1),
behind a renderer-agnostic `TerminalRenderer` interface.

- **Pick confidence: HIGH.** Of the three *named* approaches, WebView is the only one that is
  simultaneously (a) New-Arch-ready *with shipped native code* (verified), (b) able to reach a
  **remote** ttyd origin, and (c) a near-drop-in for today's `<iframe>` + `mobile-shell.ts` proxy.
  The other two are disqualified on structural grounds, not on close margins (native = multi-month
  two-platform build with **no** RN binding in existence; DOM components **cannot navigate to a
  remote origin** by design).
- **Execution-risk confidence: MEDIUM.** Two *iOS-specific* risks stack on the recommended path and
  both must be cleared in an on-device dev-client spike before committing:
  1. **react-native-webview issue #3863** — on iOS + New Architecture (Fabric), the `source` prop is
     not forwarded to native → **blank WebView**. Confirmed open, unfixed upstream, and reproduced
     on the **exact target stack (RN 0.83.1 / Expo SDK 55)**.
  2. **WKWebView cookie-sync timing** — the cookie that authenticates the ttyd WebSocket may not be
     present at first load.
- **Both risks have a sanctioned, evidence-backed mitigation** (patch-package the 13-line #3880 diff;
  plant the cookie natively and probe before going live). The distribution constraint explicitly
  allows dev-client/prebuild + custom native code, so applying an unmerged native patch is *within
  the rules*, not a hack.

**What would move execution-risk to HIGH:** one on-device iOS dev-client spike that confirms
(a) `/ttyd/<id>/` renders a live terminal with #3880 patched, and (b) the `dd_session` cookie auth
survives the WebSocket handshake on a cold launch.

## └───────────────────────────────────────────────────────────────────────┘

---

## Ranking

| # | Approach | Score /100 | One-line why |
|---|----------|-----------:|--------------|
| 1 | **react-native-webview → ttyd URL** (Option A) | **82** | New-Arch verified in the tarball; near-drop-in for the existing iframe + proxy; only iOS `source`-prop + cookie risks, both with known mitigations. |
| 2 | **react-native-webview → local HTML + WS** (Option B / omnara model) | **76** | Same library, sidesteps the cookie-sync risk (token in WS subprotocol), but you re-own the xterm client + WS framing and lose `mobile-shell.ts` reuse. Defined **fallback**, not co-equal. |
| 3 | **Native emulator (SwiftTerm / libghostty via Expo module)** | **34** | Best *rendering* fidelity, but **no RN binding exists** — it's a from-scratch two-platform native project. Pre-designed escape hatch only. |
| 4 | **xterm.js via Expo DOM components (`'use dom'`)** | **18** | Architecturally cannot navigate to a **remote** ttyd origin; would force a full client rewrite + WS-protocol ownership with zero terminal precedent. Rejected. |
| 5 | **Off-the-shelf RN "native terminal" libraries** (`@next_term`, `react-native-terminal-component`, etc.) | **6** | Graveyard: JS-only toys or AI scaffolds shipping zero native code; none pass the New-Arch gate. |

Scores weight: New-Arch pass/fail (hard gate) → reuse of existing server-side work → real shipped
precedent → iOS risk surface → maintenance health.

---

## Per-approach detail + independently verified facts

### 1. react-native-webview → ttyd URL  *(WINNER — Option A)*

- **Repo:** https://github.com/react-native-webview/react-native-webview · ~7.2k★ (verified on issue page header).
- **Maintenance:** **Active.** Latest npm `13.16.1` published **2026-02-27** (verified via `npm view … time`).
  `13.16.0` was **2025-08-25**. Latest repo commit **2026-03-30** (verified via GitHub API). Caveat
  (verified): maintainer **PR throughput is low** — the #3880 fix sat unmerged and was auto-closed
  stale (see risk below).
- **New Architecture (Fabric/TurboModule): YES — verified in the 13.16.1 tarball, not just claimed.**
  `package.json` ships `codegenConfig: { name: "RNCWebViewSpec", type: "all", ios: { componentProvider: { RNCWebView: RNCWebView } } }`; the `.podspec` gates on `RCT_NEW_ARCH_ENABLED == '1'`, adds `-DRCT_NEW_ARCH_ENABLED=1`, and depends on `React-RCTFabric`; the source tree contains `apple/newarch` + `apple/oldarch` dirs. *(The old `new-arch` dist-tag still points at the ancient `12.0.0-rc.2` — that tag is stale and irrelevant; New Arch is in the mainline `latest` now.)*
- **Expo compatibility:** First-class in **Expo SDK 55**. `npx expo install react-native-webview`
  (verified against the SDK 55 docs via context7 `/websites/expo_dev_versions_v55_0_0`). Autolinked,
  **no config plugin**, works in Expo Go and EAS dev-client/prebuild. Both `source={{uri}}` and
  `source={{html}}` documented.
- **Real working example:** **`@fressh/react-native-xtermjs-webview`** (npm v0.0.8, modified 2025-10-08)
  with production app at https://github.com/EthanShoeDev/fressh (last commit 2025-10-10, verified via
  API). Wraps `@xterm/xterm` in a WebView and exposes a **ref handle** — `write(Uint8Array)`,
  `onInitialized`, `onData(input)` — i.e. exactly the swappable-handle shape we want. (Indie SSH
  client, low activity, not a flagship — corroborating, not decisive.)
- **Risk verdict: MEDIUM** — New Arch is solid and the integration is cheap, but two iOS-specific
  risks (issue #3863 `source` prop + WKWebView cookie sync) sit directly on this path. Both have
  mitigations; neither is yet cleared on a real device.

### 2. react-native-webview → local HTML + self-opened WebSocket  *(FALLBACK — Option B)*

- **Same library / same maintenance / same New-Arch facts as #1.**
- **Real working example — VERIFIED, with two important corrections to reports 01 & 02:**
  - omnara `apps/mobile/src/components/terminal/TerminalMobileTerminal.tsx` (verified by reading the
    file): builds HTML with `xterm@5.3.0` + `xterm-addon-fit@0.8.0` from jsDelivr, opens a WS to a
    relay, passes the token via **WS subprotocol** (`omnara-supabase.` prefix), and posts status back
    via `window.ReactNativeWebView.postMessage`. Prop recipe confirmed: `keyboardDisplayRequiresUserAction={false}`,
    `hideKeyboardAccessoryView`, `domStorageEnabled`, `originWhitelist={["*"]}`, `javaScriptEnabled`.
  - **CORRECTION 1:** Reports 01 & 02 cite omnara as an *actively maintained* example ("Feb 2026").
    The repo was **ARCHIVED by its owner on 2026-02-02 — now read-only** (verified on the file's page
    header: "This repository was archived by the owner on Feb 2, 2026"). The terminal component's last
    edit was **2025-10-02**. It is a *real, shipped, but abandoned* data point — not "works today."
  - **CORRECTION 2:** omnara pins `react-native-webview` **13.15.0** and uses **`source={{ html }}`
    directly** — i.e. the exact pattern that triggers issue #3863 on iOS Fabric. So this "proven
    example" would itself be **broken on the SDK 55 / iOS New-Arch target** unless patched. It proves
    the *bridge architecture*, not that the bug is absent.
- **Why it's the fallback, not co-equal:** Option B's advantage is it puts the auth token in the WS
  subprotocol (`wss://`), **sidestepping the cookie-sync risk entirely** — so it is the natural
  contingency *if cookie auth proves flaky*. Its cost is real: you re-implement the xterm client in
  HTML and **own the ttyd WebSocket framing yourself**, losing the free reuse of `mobile-shell.ts`
  (viewport injection, `__ddTtydScroll`/`__ddTtydScrollPage`, touch-scroll). Start with A; keep B
  hot behind the same `TerminalRenderer` seam.
- **Risk verdict: MEDIUM** — no cookie risk, but more app-owned code and still subject to #3863
  (it uses the `source` prop too).

### 3. Native emulator via Expo module (SwiftTerm iOS / libghostty / native Android VT)

- **Repo (engine):** https://github.com/migueldeicaza/SwiftTerm — actively maintained, latest tag
  **v1.13.0** (verified via `git ls-remote --tags`), ~1.5k★ *(claimed; star count not re-pulled)*.
- **New Architecture:** N/A at the library level — you'd author your own Fabric/Expo-module wrapper,
  so it's "New-Arch by construction" but **none exists today**.
- **Expo compatibility:** Needs a bespoke Expo native module + config plugin + dev-client; bare native
  Swift (iOS) and a hand-built/forked VT view (Android). Not Expo Go.
- **Real working example:** Secure ShellFish, La Terminal, CodeEdit, AgentsMesh, UTM — all **native
  Swift apps**, *not* RN modules (verified pattern across reports; the rumored `SwiftTerm-RN` binding
  is a confirmed 404). **No `react-native-pty` and no `react-native-node-pty` exist** (both npm 404 —
  verified). AgentsMesh is a near-exact *architectural* template (SwiftUI over SwiftTerm fed by a
  relay WebSocket) but gives you no reusable RN code.
- **Risk verdict: HIGH** — multi-month, two-platform native build with no upstream binding; discards
  all xterm/ttyd/`mobile-shell.ts` reuse. Justified only if measured nvim/tmux redraw latency in the
  WebView is unacceptable.

### 4. xterm.js via Expo DOM components (`'use dom'`)  *(REJECTED)*

- **Source:** first-party `expo/dom`, current in SDK 55.
- **New Architecture:** YES (first-party Expo).
- **Disqualifier (architectural, not a bug):** DOM components host **bundled local web code** with
  serializable props over an async-marshalled bridge; they do **not** navigate to a remote URL. ttyd
  **is** a remote origin. So DOM forces reimplementing the xterm client *and* owning the ttyd WS
  framing — strictly worse than Option B, with **zero** terminal-over-WebSocket precedent found.
- **Risk verdict: HIGH** for this use case (the feature itself is fine; it's the wrong tool for a
  remote terminal).

### 5. Off-the-shelf RN "native terminal" libraries  *(GRAVEYARD)*

- `@next_term/native` v**0.1.0-next.0** (modified 2026-04-16) → depends on `@next_term/core`
  v**0.0.1-next.0** (verified): pre-release scaffold, native package ships no native code per report 02.
- `cawfree/react-native-terminal-component`: abandoned since 2019; JS in-memory toy, no PTY.
- `jackpal/Android-Terminal-Emulator`: archived 2022; standalone app, no Fabric surface.
- `react-native-ssh-sftp` / `react-native-ssh`: SSH *transport* only — no VT/ANSI parsing, no
  scrollback; old-arch bridge modules. Wrong layer.
- **Risk verdict: HIGH** — none passes the New-Arch gate; none is a real terminal renderer.

---

## The load-bearing risk, in full: react-native-webview #3863

This is the single most important finding of the synthesis. **Reports 01 and 02 did not mention it;
report 03 flagged it correctly.** Verified by reading the issue and PR directly:

- **Issue:** https://github.com/react-native-webview/react-native-webview/issues/3863 — "iOS - Source
  not set resulting in empty webview." **OPEN** as of 2026-05-27 (a maintainer-less back-and-forth;
  the stale-bot keeps closing/reopening it).
- **Symptom:** On **iOS + New Architecture (Fabric)**, the `source` prop is not forwarded to native →
  blank WebView. **Android is unaffected.** Reported author cause: the Fabric `updateProps` path is
  bypassed and the legacy manager's *empty macro* never sets the source.
- **Confirmed on the target stack:**
  - **RN 0.83.1** — "I can confirm this also occurs on react-native: 0.83.1 … affects any iOS project
    with Fabric enabled." (Hector-Zhuang, 2026-03-21)
  - **Expo SDK 55** — "I can confirm that the issue exists on Expo 55, **and that the above fix
    works**." (kulek1, 2026-01-25) ← *this is the decisive piece of evidence.*
- **The fix (PR #3880):** https://github.com/react-native-webview/react-native-webview/pull/3880 —
  **CLOSED (stale) 2026-03-26, never merged.** It is a **13-line native diff** to
  `apple/RNCWebViewManager.mm` that gives the previously-empty `newSource` custom-prop body a real
  implementation forwarding to `[view setSource:json]`:

  ```objc
  // apple/RNCWebViewManager.mm  (PR #3880, verified via the .diff)
  RCT_CUSTOM_VIEW_PROPERTY(newSource, NSDictionary, RNCWebViewImpl) {
    if (json == nil) {
      [view setSource:@{}];      // clear
    } else {
      [view setSource:json];     // forward the source dict to the native view
    }
  }
  ```

- **Mitigation order (apply both; first is primary):**
  1. **patch-package the #3880 diff.** Sanctioned because the distribution constraint allows custom
     native code. Confirmed working on Expo 55 by kulek1. This converts #3863 from "scary open bug"
     into "known patch, confirmed on target."
  2. **Set `source` via a `ref` / remount-via-`key`** as a secondary belt-and-suspenders (the
     ref-set workaround is confirmed only on RN 0.81.5 by o-alexandrov, *not* re-verified on 0.83.1 —
     so treat it as secondary, not primary). The evidence is *mixed* on whether the bug is
     update-path-only or also initial-render, so don't rely on "mount once, never update `source`."

**Bottom line:** #3863 is real and on-target, but **mitigable by design** under our constraints. It
moves the recommendation from "trivial drop-in" to "drop-in with one patch + one device spike."

### Secondary iOS risk: WKWebView cookie sync (Option A only)

ttyd's WebSocket is authed by an `HttpOnly` `dd_session` cookie (the front-proxy gates both assets and
the WS upgrade; browser WS handshakes can't carry `Authorization`). iOS WKWebView cookie sync is
documented as timing-unreliable. **Mitigation:** plant `dd_session` via `@react-native-cookies/cookies`
(v6.2.1, modified 2026-01-31 — verified active), `await` it, mount a fresh WebView (`sharedCookiesEnabled`
+ `thirdPartyCookiesEnabled`), and re-probe `/ttyd/<id>/` for `200` before going live (reuse the existing
`TtydFrame` readiness probe). **If still flaky → switch to Option B**, where the token rides the WS
subprotocol and the cookie is irrelevant.

---

## The swappable terminal interface (`TerminalRenderer`)

Renderer-agnostic by design: **no WebView/`injectJavaScript` leaks into the contract**, so a future
`NativeTerminalRenderer` (SwiftTerm/libghostty via Expo module) drops in without an app rewrite. The
existing `__ddTtydScroll` / `__ddTtydScrollPage` and the `.xterm-helper-textarea` key dispatch from
`src/dev-dashboard/ui/src/lib/iframe-keys.ts` become **private internals of the WebView impl** behind
`scroll()` / `sendKey()`.

```ts
// Reuse the existing key union from iframe-keys.ts so the keybar stays renderer-agnostic.
export type TerminalKey =
  | "Escape" | "Tab"
  | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"
  | "PageUp" | "PageDown";

export type TerminalStatus =
  | "idle" | "connecting" | "connected" | "disconnected" | "ended" | "error";

export interface TerminalCallbacks {
  /** Raw bytes produced by the user / the terminal session (UTF-8 or binary frames). */
  onData?: (chunk: Uint8Array) => void;
  /** Lifecycle transitions — drives reconnect UI, banners, the keybar enabled state. */
  onStatus?: (status: TerminalStatus, detail?: string) => void;
  /** Renderer (WebView content-process, native view, …) died; caller should re-attach. */
  onExit?: (reason: "crash" | "remote-close" | "auth-failed" | "unknown") => void;
  /** Text the user selected, for the copy affordance. */
  onSelection?: (text: string) => void;
}

export interface TerminalSession {
  /** Opaque session id (tmux/cmux session surfaced through ttyd). */
  readonly id: string;
}

/**
 * One swappable terminal backend. v1 = WebViewTerminalRenderer (ttyd URL).
 * Fallback  = WebViewHtmlTerminalRenderer (local HTML + WS subprotocol).
 * Escape hatch = NativeTerminalRenderer (SwiftTerm/libghostty via Expo module).
 *
 * The contract is transport- and renderer-agnostic: it never exposes a WebView,
 * a DOM node, injectJavaScript, or a URL shape. Implementations own those details.
 */
export interface TerminalRenderer {
  /** Connect/mount against a session; resolves once the surface is live (post readiness probe). */
  attach(session: TerminalSession, cb: TerminalCallbacks): Promise<void>;
  /** Tear down WS + view; safe to call repeatedly; idempotent. */
  detach(): Promise<void>;

  /** Feed user input (typed text / pasted text / IME commit) into the session. */
  sendInput(text: string): void;
  /** Send a named control key (Esc/Tab/Arrows/PageUp/PageDown) — maps to the right ESC seq. */
  sendKey(key: TerminalKey, mods?: { ctrl?: boolean; alt?: boolean; shift?: boolean }): void;
  /** Convenience for the keybar Paste button; defaults to sendInput(text). */
  paste(text: string): void;

  /** Scroll the scrollback by N lines (− = older / up, + = newer / down). */
  scroll(lines: number): void;
  /** Scroll ~one visible screen (−1 = up, +1 = down). */
  scrollPage(direction: -1 | 1): void;

  /** Re-fit cols/rows to the current view size (call on rotation / keyboard show-hide). */
  fit(): void;
  /** Explicit resize when the caller already knows the target geometry. */
  resize(cols: number, rows: number): void;

  /** Raise the on-screen keyboard / give the surface input focus. */
  focus(): void;

  /** Current connection state for imperative checks. */
  readonly status: TerminalStatus;
}
```

**How today's code maps onto the WebView impl (no rewrite, just relocation):**

| Existing web artifact | Becomes (WebView impl internal) |
|---|---|
| `injectTtydMobileShell()` viewport + `__ddTtydScroll`/`__ddTtydScrollPage` (`mobile-shell.ts`) | Unchanged — server-side proxy injection still runs; the WebView inherits it for free (Option A). |
| `dispatchKey()` on `.xterm-helper-textarea` (`iframe-keys.ts`) | `webView.injectJavaScript(...)` inside `sendKey()` — *easier* than the iframe path because injected JS runs in page context (no cross-origin guard). |
| `scrollIframeTerminal*()` postMessage path | `scroll()` / `scrollPage()` → `injectJavaScript('window.__ddTtydScroll(...)')`. |
| `MobileKeyBar.tsx` (window.visualViewport-driven) | Native RN button bar driven by RN `Keyboard` events + safe-area insets; add a **sticky Ctrl modifier** + **Paste** button + common punctuation (Ctrl & copy/paste are the WebView weak spots). |

---

## Migration note

1. **Build `WebViewTerminalRenderer` (Option A) first.** `source={{ uri: '/ttyd/<id>/' }}` set **via
   ref** (not the reactive prop), with the #3880 patch applied via `patch-package`. Reuse the
   `TtydFrame` readiness probe before flipping `status → connected`.
2. **Prop recipe (converged + verified against omnara):** `keyboardDisplayRequiresUserAction={false}`
   (the single most-missed prop — programmatic focus won't raise the iOS keyboard without it),
   `hideKeyboardAccessoryView`, `sharedCookiesEnabled`, `thirdPartyCookiesEnabled`, `domStorageEnabled`,
   `originWhitelist={['*']}`, `bounces={false}`, `overScrollMode='never'`,
   `automaticallyAdjustContentInsets={false}`, `contentInsetAdjustmentBehavior='never'`. Wire
   `onContentProcessDidTerminate` (iOS) / `onRenderProcessGone` (Android) → remount via `key` and
   re-`attach()` (tmux/cmux makes reattach stateful and cheap). Force `autocorrect/autocapitalize/
   autocomplete=off` + `spellcheck=false` on the helper textarea after load to stop IME corruption.
3. **Device spike gate (before committing to A):** on a real iOS device with the #3880 patch, confirm
   (a) the ttyd URL renders a live terminal, and (b) `dd_session` cookie auth survives the WS
   handshake on cold launch. If (b) fails after the cookie-plant + probe mitigation → **switch to
   `WebViewHtmlTerminalRenderer` (Option B)** behind the same interface: token in WS subprotocol over
   `wss://`, no cookie dependency. Zero app-surface churn because both sit behind `TerminalRenderer`.
4. **Do not** enable `@xterm/addon-webgl` on iOS (WKWebView WebGL historically flaky); keep xterm on
   the DOM renderer. Coalesce writes (rAF + ~8KB) to keep redraw smooth.
5. **Escape hatch (only if measured nvim/tmux redraw latency is unacceptable):** implement
   `NativeTerminalRenderer` against SwiftTerm (iOS) via an Expo module + config plugin. AgentsMesh is
   the architectural template. This is a contingency, pre-designed via the seam — not part of v1.

---

## Corrections to the upstream reports

1. **#3863 is a hard, on-target risk that reports 01 & 02 omitted.** It is OPEN, unfixed upstream, and
   reproduced on **RN 0.83.1 / Expo SDK 55** — i.e. it directly threatens *both* recommended options.
   Report 03 caught it; the synthesis elevates it to the central caveat. (Report 03's claim that the
   working fix #3880 "sat unmerged for months and was auto-closed stale" is **confirmed**: closed
   2026-03-26.)
2. **omnara is ARCHIVED (2026-02-02), not actively maintained.** Reports 01 & 02 cite it as a current
   example "Feb 2026"; it is shipped-but-abandoned, terminal component last touched 2025-10-02.
3. **omnara would itself hit #3863:** it pins RNW 13.15.0 and uses `source={{ html }}` directly with no
   ref/patch workaround — so it proves the *bridge architecture*, not that the bug is absent on iOS
   New Arch.
4. **The stale `new-arch` dist-tag (`12.0.0-rc.2`) is a red herring** — New Architecture support lives
   in the mainline `latest` (13.16.x), verified in the tarball's `codegenConfig` + podspec.
5. **paseo** (report 01: "~6.9k★, last commit May 2026") could **not** be independently located via
   the tools available here (no resolvable repo at the obvious paths). Treat the paseo citation as
   *claimed, not re-verified*. The verified living evidence for the pattern is
   `@fressh/react-native-xtermjs-webview` + the (archived but real) omnara, plus kulek1's
   patch-works-on-Expo-55 confirmation.
6. **Verified negatives hold:** no `react-native-pty`, no `react-native-node-pty` (both npm 404);
   `@next_term/*` is pre-release scaffold (core `0.0.1-next.0`).
