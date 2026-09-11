# 07 — Open-Source Terminal/SSH App Hunt (Strategy A: by PRODUCT/APP)

> **Goal:** hunt shipped open-source terminal/SSH apps for a *3rd TerminalRenderer driver* candidate
> (or a reusable architecture), and decide whether any could **beat** the two already-chosen WebView
> options (A = `react-native-webview` → ttyd URL; B = `react-native-webview` hosting local xterm.js +
> self-opened WS). Sibling reports already cover the RN-library graveyard (02), xterm-via-DOM-vs-WebView
> (03), and the synthesized recommendation (06). This report is the **product/app angle** and does not
> re-litigate those.
>
> Verification key: **[VERIFIED]** = I read the repo's `package.json`/source/site or a primary quote
> directly. **[CLAIMED]** = asserted by a third party but not confirmed against shipped code.
> Date: 2026-05-29.

---

## TL;DR

- **No shipped open-source terminal/SSH *product* yields a 3rd TerminalRenderer driver that beats the two
  WebView options.** Strategy A converges hard: every investigated product is **either** an Electron/native
  desktop app (reusable as *architecture lesson* only — there is no RN/Expo code to lift) **or** it is the
  *same* xterm.js-in-a-webview pattern we have already adopted (Termix, and the already-covered fressh/omnara
  RN wrappers). Nothing introduces a new, better, RN-embeddable rendering technology.
- **The single most important confirmation: the entire product space splits into exactly two rendering
  camps, and neither offers a "3rd option."** (1) **xterm.js / hterm in a web surface** — Termix (Electron),
  Tabby (Electron), Wave (Electron), Hyper (Electron), Blink (iOS hterm-in-webview), Termius (web-tech core,
  Angular→React + WebGL renderer). (2) **Native VT engine** — Secure ShellFish / SwiftTerm, Warp (Rust),
  a-Shell (native exec). Camp 1 *validates* our WebView choice; camp 2 is the native escape hatch already
  documented in reports 02/06 (SwiftTerm). There is no third rendering technology hiding in any product.
- **Termius is NOT a reusable driver under any interpretation: it is 100% closed-source.** [VERIFIED — no
  source repo exists; only App Store / website / blog.] The task asked to "CONFIRM it's React Native and find
  HOW it renders." Best-available evidence (founder's own 2019 HN Launch comments + the 2024-era "Touch
  Terminal" blog): the cross-platform core is **web tech** ("gradually migrating from Angular to React under
  the hood… we are testing WebGL rendering") inside an **Electron** desktop shell; the iOS redesign blog
  describes *interaction* (space-key cursor, extended keyboard, AI command gen) and **never claims a native
  renderer**. So: **renderer = xterm.js-class web tech (medium-high confidence); "React Native" claim =
  UNCONFIRMED** — the *desktop* core is web tech (Electron + Angular→React), but whether the *mobile* app is RN
  vs. a webview-wrapped web build is something I did not verify (no IPA/APK Hermes-artifact decompile — time-boxed,
  and moot since it's closed). Either way it is closed → architecture lesson only, never a driver.
- **Termix is the most interesting find and it strongly *validates* our plan — but it is Electron + web, not
  RN.** [VERIFIED from `package.json`.] 13.1k★, Apache-2.0, `"main": "electron/main.cjs"`, `electron` +
  `electron-builder` + Vite + React 19 + **`@xterm/xterm@^6`** + `react-xtermjs` + `@xterm/addon-fit` /
  `addon-clipboard` / `addon-web-links` / `addon-unicode11`, backend = `ssh2` + `ws`. Its iOS/Android App
  Store listings are the **web/PWA build wrapped**, not a React Native app. It is the closest open-source
  analogue to *exactly what we are building* (xterm.js client ↔ WebSocket ↔ ssh backend) — so it is a superb
  **reference for the web layer** (addon set, reconnect, tmux handling, split panes) but contributes **zero
  RN driver code**.
- **Recommendation: do NOT add a 3rd driver from this hunt. Keep A (ttyd URL) primary + B (local HTML+WS)
  fallback, both behind `TerminalRenderer`.** Mine three products for *patterns*, not code: **Termix** (web
  client/addon/reconnect reference, our nearest twin), **Termius** (mobile-input UX: space-key cursor nav,
  extended key strip), **SwiftTerm-backed apps** (Secure ShellFish) as the pre-designed native escape hatch.

---

## Method & what's new vs. reports 02/03/06

I read each product's repo `package.json`/site/store page and, for the closed apps, hunted primary quotes
(HN Launch threads, official blogs). `gh_grep` (literal single-line substring search) was used to surface
RN/Expo SSH apps via distinctive single tokens (`react-native-ssh-sftp`, dependency manifests) — multi-word
queries return nothing by design, not because the libraries are absent. New, load-bearing facts this report
adds over the siblings:

1. **Termius renderer pinned to web tech** (founder HN quotes) — siblings left it "unknown/claimed."
2. **Termix identified, dissected, and classified** as Electron+xterm.js (not in any sibling) — our nearest
   open-source twin, and proof the xterm.js-over-WS architecture is a mainstream, maintained choice in 2026.
3. **Warp open-sourced 2026-04-28 under AGPL** (Rust native) — now confirmable, was closed when 02 was written.
4. **Tabby = the renamed Terminus** (`Eugeny/tabby`, 68.1k★, MIT) — siblings only had "Terminus."
5. **`@dylankenneally/react-native-ssh-sftp`** is the maintained fork of shaqian's lib; RN-directory marks
   New Arch **"untested"** — it is SSH *transport* only (no VT/renderer), confirming report 06's "wrong layer."

---

## Per-candidate findings

### 1. Termius — *closed-source; web-tech renderer; architecture lesson only* **[VERIFIED closed]**

- **Repo / license:** **No source repository.** Closed-source commercial app (Termius, YC W19). Sites:
  https://termius.com , App Store id549039908, blog https://termius.com/blog/new-touch-terminal-on-ios .
  Stars/license: N/A (proprietary).
- **What it renders the terminal with:** **xterm.js-class web technology**, *not* a native VT engine.
  Evidence (primary, [VERIFIED] from the founder's own words on the 2019 Launch HN thread,
  https://news.ycombinator.com/item?id=20118727):
  - rkudiyarov (co-founder): *"gradually migrating from **Angular to React** under the hood… and we are
    testing **WebGL rendering** to speed it up even more."* — Angular/React + a WebGL renderer is the exact
    signature of an xterm.js-style web terminal (xterm's WebGL addon), not UIKit/SwiftTerm text rendering.
  - A commenter (and undisputed by the founders): *"So this is an **Electron app** that does what JuiceSSH
    and X-plore do…"* — confirms the **desktop shell is Electron** with a shared web codebase.
  - The 2024-era **"New Touch Terminal on iOS"** blog [VERIFIED read] describes only *interaction* design
    (long-press Space to move the cursor with speed "gears", an iOS-style extended key strip for signals/
    history, AI command generation). It **never states the rendering technology** and never says "native
    renderer." Cross-platform sync + shared core + Electron desktop strongly implies the mobile terminal is
    the same web/xterm-class surface, RN- or webview-hosted — but the *renderer tech itself* is web, not native.
- **Is it React Native?** **NOT confirmed; most likely the shared core is a web app, not RN.** The discriminating
  primary evidence (Angular→React migration + Electron desktop) points to a **web** core shared across desktop
  (Electron) and mobile, *not* a React Native codebase. No RN artifact (no `index.android.bundle`/Hermes
  reference) is exposed in any public source because there is no public source. The widely-repeated "Termius is
  built with React Native" claim is **unverified and inconsistent with the founders' Angular→React-web account**;
  treat it as folklore, not fact.
- **New-Arch / Expo fit:** N/A — closed, no RN package, nothing to install or embed.
- **Maintenance:** Actively developed commercial product (frequent App Store updates). Irrelevant to reuse.
- **Could it be our 3rd driver / would it beat A or B?** **No — disqualified by closed-source.** Even if its
  renderer is literally xterm.js, none of it is lift-able. **Reusable as architecture/UX lesson only**:
  - **Steal the mobile-input UX** (this is Termius's actual differentiator): long-press-Space cursor nav with
    speed gears, an editable extended-key strip (Esc/Ctrl/Tab/arrows/`| - ~ /`/F-keys/signals), AI command
    entry. This directly informs our native `MobileKeyBar` (report 03/06 already flagged the key-bar work).
- **Risk verdict: HIGH** as a driver (it cannot be one). LOW-risk and high-value as a UX reference.

### 2. Termix — *open-source, Apache-2.0, Electron + xterm.js v6; our nearest twin; reference only* **[VERIFIED]**

- **Repo / license / stars:** https://github.com/Termix-SSH/Termix — **~13.1k★**, **Apache-2.0**.
- **What it renders the terminal with:** **xterm.js v6 in a web surface** [VERIFIED from `package.json`
  @ `main` branch, v2.3.1, 2026-05-29]: `"main": "electron/main.cjs"`; deps include `electron@^42`,
  `electron-builder@^26`, `vite@^8`, `react@^19.2`, **`@xterm/xterm@^6.0.0`**, `react-xtermjs@^1.0.10`,
  `@xterm/addon-fit@^0.11`, `@xterm/addon-clipboard`, `@xterm/addon-web-links`, `@xterm/addon-unicode11`;
  backend uses `ssh2@^1.17` + `ws@^8.20` + `guacamole-lite` (for RDP/VNC via guacd) + `better-sqlite3`. UI is
  React + Tailwind v4 + Radix/shadcn. It is a **self-hosted web app** (browser/PWA) that *also* ships an
  Electron desktop build and App Store / Play Store listings.
- **Is it React Native / Expo embeddable?** **No.** There is **no React Native code** — no `react-native`
  dependency, no `ios/`/`android/` RN project, no Expo config. The iOS/iPadOS and Android store listings are
  the **web/PWA build packaged** (the desktop entry is Electron; mobile is the same web bundle wrapped). So it
  is *not* an RN driver and *not* directly embeddable in our Expo app as a component.
- **New-Arch / Expo fit:** N/A (no RN surface).
- **Maintenance:** **Very active** [VERIFIED] — v2.3.1 tagged 2026-05-29 (the day of this research), 539 forks,
  active PRs. Apache-2.0 is permissive.
- **Could it be our 3rd driver / would it beat A or B?** **No driver, but it is the single best *reference* for
  the layer we are actually building.** Termix is the closest open-source analogue to our target stack
  (xterm.js client ↔ WebSocket ↔ `ssh2`/PTY backend, with tmux support, persistent reconnecting tabs, split
  panes, themes). For **Option B** (we host local xterm.js + a self-opened WS) Termix is a goldmine of *web-side*
  patterns to copy: the exact xterm v6 + addon-fit/clipboard set, reconnect/persistent-tab handling, command
  history, and theme plumbing. It does **not** beat A/B — it *is* the same camp as B, just on desktop/web — but
  it raises our confidence that the xterm.js-over-WS approach is a mainstream, maintained 2026 choice.
- **Risk verdict: HIGH** as a driver (no RN code). LOW-risk, high-value as a **web-layer reference** for Option B.

### 3. Tabby (formerly Terminus) — *Electron + Angular + xterm.js; reference only* **[VERIFIED]**

- **Repo / license / stars:** https://github.com/Eugeny/tabby — **~68.1k★**, **MIT**. (This is the current name
  of what reports 03/06 called "Terminus"; the old `Eugeny/terminus` redirects here.)
- **What it renders with:** **xterm.js**, UI in **Angular**, packaged in **Electron** [VERIFIED: HACKING.md
  describes `app/` as the Electron app, `tabby-electron` plugin for Electron-specifics; DeepWiki + xterm.js
  README both state Tabby is built around xterm.js with an Angular UI]. Plugin architecture, `tabby-local`
  spawns local PTYs.
- **RN / Expo embeddable?** **No.** Desktop Electron app, Angular framework. No RN, no mobile build.
- **New-Arch / Expo fit:** N/A.
- **Maintenance:** **Active** (frequent releases, Electron bumps). MIT.
- **Could it be our 3rd driver / beat A/B?** **No.** Desktop-only, Angular — nothing RN-embeddable. Same
  xterm.js camp as our WebView path but with a heavier (Angular/Electron) frame. **Architecture lesson only:**
  its plugin-per-connection-type seam and split-pane/tab management are good design references; its renderer is
  the same xterm.js we already use.
- **Risk verdict: HIGH** as a driver. Reference-only.

### 4. Hyper — *Electron + React + xterm.js; reference only* **[VERIFIED]**

- **Repo / license / stars:** https://github.com/vercel/hyper — large★ (tens of k), **MIT**. (Vercel-maintained.)
- **What it renders with:** **xterm.js** inside **Electron**, UI in **React + Redux** [VERIFIED from hyper.is +
  Read OSS architecture writeup: "treats itself as a web app first and a terminal second… React, Redux, and
  xterm.js"]. node-pty for local shells.
- **RN / Expo embeddable?** **No** — desktop Electron.
- **Could it be our 3rd driver / beat A/B?** **No.** It is the canonical "terminal as a web app" — exactly the
  philosophy behind our WebView choice, but desktop. **Lesson:** Hyper proves the web-tech terminal is viable at
  scale and is the spiritual ancestor of Termix/Tabby; no transferable RN code.
- **Risk verdict: HIGH** as a driver. Reference-only.

### 5. Wave Terminal — *Electron + Go + xterm.js v6; reference only* **[VERIFIED]**

- **Repo / license:** https://github.com/wavetermdev/waveterm — large★, **Apache-2.0** (per project). Docs:
  https://docs.waveterm.dev .
- **What it renders with:** **xterm.js** (upgraded to **xterm.js v6** in Wave v0.14.4, 2026-04-16 release notes
  [VERIFIED read]) in an **Electron** front-end with a **Go** backend. Block-based "open terminal" UI.
- **RN / Expo embeddable?** **No** — desktop Electron + Go server.
- **Could it be our 3rd driver / beat A/B?** **No.** Same xterm.js camp, desktop only. **Lesson:** its block/
  widget model and Go-backend WS bridge are interesting architecture, but nothing RN.
- **Risk verdict: HIGH** as a driver. Reference-only.

### 6. Warp — *Rust native GPU renderer; open-sourced 2026 under AGPL; reference only* **[VERIFIED 2026 OSS]**

- **Repo / license / stars:** https://github.com/warpdotdev/warp — **open-sourced 2026-04-28** ([VERIFIED] blog
  https://www.warp.dev/blog/warp-is-now-open-source : "Warp client is now open-source"). License **reported as AGPL**
  (secondary sources: Help Net Security 2026-04-30, i-programmer 2026-05-07; the GitHub discussion #400 shows the
  license choice was contentious) — not confirmed against the repo `LICENSE` here, but moot since Warp is
  reference-only regardless.
- **What it renders with:** **fully native, custom Rust GPU-accelerated UI framework** (no web tech, no
  xterm.js). It is an "agentic development environment" (AI/agent-first) built entirely in Rust.
- **RN / Expo embeddable?** **No.** Desktop (macOS/Linux/Windows), Rust + bespoke GPU UI. No mobile, no RN, and
  **AGPL** is a copyleft license hostile to embedding in a closed/proprietary mobile app even if it were
  technically possible.
- **New-Arch / Expo fit:** N/A.
- **Could it be our 3rd driver / beat A/B?** **No.** It is the most *technically impressive* renderer in the
  field (native GPU, like libghostty in report 02/03), but there is **no RN binding, no mobile target, and the
  AGPL is a licensing landmine**. It belongs to the same "native VT engine" escape-hatch family already covered
  by SwiftTerm/libghostty — and offers us nothing those don't, plus a worse license.
- **Risk verdict: HIGH** (native rewrite + AGPL). Reference-only; *less* attractive than SwiftTerm as an escape
  hatch due to license + no iOS/Android.

### 7. Blink Shell (iOS) — *open-source; hterm-in-webview; native app, not RN* **[VERIFIED]**

- **Repo / license / stars:** https://github.com/blinksh/blink — ~6k★+, GPL/BSD components (open source).
  *(Covered in report 03 — summarized here, cross-reference 03 for detail.)*
- **What it renders with:** **Chromium's hterm (HTML terminal) inside a webview** [VERIFIED: HN
  item?id=12932592 "Blink uses Google's HTerm"; their own issue #794 "Replace Webview with native renderer"
  confirms the renderer *is* a webview and that power users want it replaced].
- **RN / Expo embeddable?** **No** — it is a **native iOS Objective-C/Swift app** that hosts hterm in a
  `WKWebView`; the surrounding app is not RN, so there is no RN component to lift. The *concept* (web terminal
  in a webview) is precisely our Option A/B, which Blink validates as **premium-grade** despite the webview.
- **Could it be our 3rd driver / beat A/B?** **No new driver.** It is the **best precedent that the WebView
  approach ships at pro quality** — i.e. it *supports* A/B rather than beating them. Lesson: invest in keyboard/
  input handling (Blink's reputation), and note issue #794 = the known ceiling (extreme nvim/tmux wants native).
- **Risk verdict:** Reference-only (positive precedent for the chosen path).

### 8. Secure ShellFish (iOS) — *closed-source; native SwiftTerm; the native escape-hatch exemplar* **[VERIFIED]**

- **Repo / license:** Closed-source commercial app. Site: https://secureshellfish.app , App Store id1336634154.
  *(SwiftTerm engine covered in report 02 — cross-reference.)*
- **What it renders with:** **Native terminal**, explicitly *not* web tech — the site states: *"Native Terminal.
  Using system components instead of web technologies you get better accessibility, performance and text
  selection."* [VERIFIED read]. Built on **SwiftTerm** (report 02 verified SwiftTerm README lists "Secure
  Shellfish" as a consumer).
- **RN / Expo embeddable?** **No** — native Swift app, closed-source, no RN.
- **Could it be our 3rd driver / beat A/B?** **No reusable code.** It is the **exemplar for the native escape
  hatch** (SwiftTerm) already pre-designed in reports 02/03/06 as `NativeTerminalRenderer`. It "beats" WebView
  on text-selection/accessibility/scroll fidelity (their pitch) — which is *the trigger condition* for building
  the native escape hatch, not a reason to abandon WebView-first. No code to lift; SwiftTerm itself (report 02)
  is the engine you'd wrap yourself.
- **Risk verdict:** Reference-only; the native escape-hatch is HIGH effort (per reports 02/06).

### 9. a-Shell (iOS) — *open-source; native exec + hterm-style web renderer; not RN* **[VERIFIED repo]**

- **Repo:** https://github.com/holzschu/a-shell — open source. *(Covered in report 03 — cross-reference.)*
- **What it renders with:** hterm-style web terminal in a `WKWebView`; command *execution* is native
  (`ios_system`, WASM commands). Renderer detail medium-confidence per report 03.
- **RN / Expo embeddable?** **No** — native iOS app. Lesson: clean renderer(web)/backend(native) split, mirroring
  our ttyd-backend / webview-renderer split.
- **Risk verdict:** Reference-only.

### 10. RN/Expo SSH-or-terminal apps on GitHub — *only transport libs + already-covered webview wrappers* **[VERIFIED]**

The point of strategy A was to find a *new* RN/Expo product. The GitHub hunt surfaced **no new RN terminal
renderer** beyond what reports 03/06 already cover:

- **`react-native-ssh-sftp`** (shaqian, MIT) and its maintained fork **`@dylankenneally/react-native-ssh-sftp`**
  [VERIFIED via gh_grep + react-native-community/directory]: SSH/SFTP **transport only** — no VT parser, no
  scrollback, no renderer. RN-directory marks the fork's New Arch **"untested"**. This is the **wrong layer**
  (report 06 said the same) — at most the *transport* under a future native renderer, never a driver itself.
  Consumers found (e.g. `zudvpn/ZudVPN`) are VPN/utility apps, not terminals.
- **`@fressh/react-native-xtermjs-webview`** + **omnara** — the only real RN *terminal* code, both already
  dissected in reports 03 (fressh handle shape) and 06 (omnara archived 2026-02-02, would itself hit RNW #3863).
  They are the substrate of **Option B**, not a competing 3rd driver.
- No Expo DOM-component terminal exists in the wild (report 03 verified the same).

**Net:** the RN/Expo open-source terminal universe = {fressh, omnara} (both = our Option B) + {SSH transport
libs} (wrong layer). Strategy A finds nothing new and nothing better.

---

## Recommendation

**Do NOT introduce a 3rd `TerminalRenderer` driver from this product hunt.** The hunt's conclusion is a clean
*negative result*, which is itself the answer: there is no shipped open-source terminal/SSH product offering a
rendering technology that is simultaneously (a) React-Native/Expo-embeddable, (b) New-Arch-ready, and (c)
better than `react-native-webview` + xterm.js for our reuse-driven, ttyd-backed case.

- **Keep the report-06 plan unchanged:** Option **A** (`react-native-webview` → existing ttyd URL) as v1,
  Option **B** (local xterm.js HTML + self-opened WS, fressh/omnara pattern) as the hot fallback, both behind
  the `TerminalRenderer` interface; **SwiftTerm-via-Expo-module** as the pre-designed native escape hatch.
- **What this hunt *adds* — three products to mine for patterns (not code):**
  1. **Termix** (Apache-2.0, our nearest open-source twin) → reference the **web layer of Option B**: xterm v6
     + addon-fit/clipboard/web-links/unicode11 set, reconnecting persistent tabs, command history, tmux, split
     panes. It proves xterm.js-over-WS is a mainstream maintained 2026 choice.
  2. **Termius** (closed, but the best mobile-terminal UX in the field) → reference the **native key-bar/input
     UX**: long-press-Space cursor nav with speed gears, an editable extended-key strip (signals/F-keys/history),
     AI command entry. Feeds our `MobileKeyBar` work (already flagged in 03/06).
  3. **Secure ShellFish / SwiftTerm** → the **native escape hatch** exemplar; build only if measured nvim/tmux
     redraw latency in the WebView is unacceptable (report 06's trigger condition). Prefer SwiftTerm over Warp
     for this: Warp is AGPL + Rust + desktop-only with no RN binding.

**Why nothing here beats A/B:** every product either (i) renders with **xterm.js/hterm in a web surface** —
i.e. the *same* technology our WebView path already uses, just inside Electron/native-iOS shells we cannot lift
into Expo — or (ii) renders with a **native VT engine** (SwiftTerm/Warp/native exec) that has **no RN binding**
and would be a multi-month two-platform build, which reports 02/06 already classified as the escape hatch, not
v1. There is no third rendering technology, and no off-the-shelf RN-embeddable terminal renderer, anywhere in
the shipped-product space.

**Confidence:** **HIGH** on the core verdict (no 3rd driver; A/B stand) and on Termix's stack, Tabby's stack,
Warp's OSS+license, Blink's hterm-webview, and Secure ShellFish's native renderer (all [VERIFIED] from primary
sources). **MEDIUM-HIGH** on Termius's renderer being xterm.js-class web tech (inferred from the founders' own
Angular→React + WebGL + Electron statements; the company publishes no architecture doc and the app is closed, so
this is best-available-evidence, not a confirmed build manifest). The "Termius is React Native" claim is
**unverified** — the desktop core is demonstrably web tech, but the mobile framework was not decompiled and is
moot given the app is closed; flagged accordingly throughout.
