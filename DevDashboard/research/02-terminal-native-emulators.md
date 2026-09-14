# Native / Non-WebView RN Terminal Emulators — The Graveyard Check (Expo SDK 55)

**TL;DR**
- **There is NO production-ready, New-Architecture-compatible, fully-native React Native terminal-emulator library in existence as of 2026-05-29.** Every candidate is one of: a JS-only in-memory toy (no real PTY), an abandoned pre-Fabric experiment, an AI-scaffolded repo whose "native" package ships zero native code, or an iOS-only Swift library with no RN binding.
- The strongest *native engine* (`migueldeicaza/SwiftTerm`, 1,555★, actively maintained) is real and battle-tested — but **only inside native Swift/SwiftUI apps** (UTM, AgentsMesh, etc.). **No React Native / Fabric binding for it exists** on npm or GitHub; the often-cited `SwiftTerm-RN` repo is a 404 (verified). Android has no equivalent maintained emulator-as-library at all (jackpal's is archived).
- **Conclusion: a fully-native option is NOT viable on Expo SDK 55 today** as an off-the-shelf dependency. Going native means *building and maintaining your own Fabric/TurboModule wrapper around two different native engines (SwiftTerm on iOS + a hand-rolled Android VT view), plus the PTY/SSH transport* — months of work, two platforms, no upstream. The WebView+xterm.js path (covered in a sibling report) remains the only realistic terminal-parity approach for SDK 55.

---

## Methodology & verification key

Searched npm, GitHub (REST API via `gh`), `gh_grep` code search, Jina/Brave web search, and Expo SDK 55 docs (context7). For each candidate I distinguish:
- **[VERIFIED]** — I read the repo's `package.json`, source tree, commit history, or npm page directly.
- **[CLAIMED]** — asserted by a README/blog but not backed by shipped native code I could inspect.

Hard gate applied per task: **Expo SDK 55 removed the Legacy Architecture; New Architecture (Fabric + TurboModules) is mandatory.** Any library that is pre-Fabric, JS-only, or never built its native side fails the gate.

---

## Option 1 — `react-term` / `@next_term/native` (rahulpandita/react-term)

- **Repo:** https://github.com/rahulpandita/react-term — **~3 stars**, 0 forks, 18 open issues. npm: `@next_term/native` (also `@next_term/core`, `/web`, `/react`).
- **Maintenance:** Created **2026-03-11**, last push **2026-05-11** [VERIFIED via GitHub API]. Very active commit stream — but **almost entirely AI-authored** ("rahulpandita and claude authored", "github-actions[bot] and Copilot authored" on nearly every commit). 39 weekly npm downloads, **0 dependents**, version `0.1.0-next.0`, **no README on npm**.
- **New Architecture support:** **NO (the native side does not exist).** [VERIFIED] The `packages/native` directory contains ONLY `package.json`, `tsconfig.json`, and a `src/` of TypeScript files. There is **no `ios/` folder, no `android/` folder, no `.podspec`, no `build.gradle`, no `.swift`/`.kt`/`.mm`/`.cpp`**. The `src/turbo-module/NativeTerminalCore.ts` is a *TypeScript interface only* — its own header comment states: *"This TypeScript interface defines the contract that a native C++ TurboModule **would** implement via JSI… **Until the native module is built**, the JS-side NativeTerminal component uses @next_term/core's BufferSet + VTParser as a fallback."* The `SkiaRenderer.ts` header likewise says *"Skia-based renderer for React Native **(JS fallback)** … This keeps all rendering logic testable **without native dependencies**."* So "TurboModule-ready" means "we wrote the TS spec file"; the renderer is pure-JS emitting Skia draw commands, and `@shopify/react-native-skia` isn't even a declared dependency.
- **Expo compatibility:** Irrelevant in practice — even the JS-fallback `NativeTerminal` requires `@shopify/react-native-skia` (needs dev-client/prebuild, not Expo Go) which the package doesn't declare. Peer deps are just `react` + `react-native >=0.73`. It is *not* a runnable terminal you can `expo install`.
- **Real working example:** **None.** No example app in the native package, no shipped app, 0 dependents. The web packages have a demo; the native package is a scaffold.
- **PTY / real shell:** **No.** It's a VT *parser/renderer*; you'd still wire your own PTY/WebSocket transport (`onData` callback). For ttyd parity you'd feed it the same WebSocket stream ttyd uses.
- **Risk verdict:** **HIGH** — solo, ~3-star, AI-generated, pre-1.0, the "native" package ships no native code, 0 real users. Not adoptable; at best a reference for the *parser* layer.

## Option 2 — `migueldeicaza/SwiftTerm` (the real native engine — iOS only, no RN binding)

- **Repo:** https://github.com/migueldeicaza/SwiftTerm — **1,555 stars**, 324 forks, 75 open issues.
- **Maintenance:** **Actively maintained** [VERIFIED] — last push **2026-05-18**, latest tag **v1.13.0** (recent: v1.13.0 / v1.12.0 / v1.11.2). Authored by Miguel de Icaza (Xamarin/GNOME). Mature, high-fidelity Xterm/VT100 emulator with iOS `UIKit` `TerminalView`, macOS `AppKit`, Unicode, mouse, scrollback.
- **New Architecture support:** **N/A — it is not a React Native library.** It's a pure Swift Package (SPM). There is **no JS/TS surface, no Fabric component, no TurboModule** in it.
- **Expo compatibility:** **None directly.** To use it from Expo SDK 55 you would write your own Expo Module / Fabric native component wrapping `TerminalView` (Swift), distributed via a config plugin + dev-client/prebuild. That is a from-scratch native-module project, not a dependency you install.
- **Real working examples (all NATIVE Swift, NOT React Native)** [VERIFIED via gh_grep]:
  - `utmapp/UTM` — `VMDisplayTerminalViewController.swift` imports SwiftTerm.
  - `AgentsMesh/AgentsMesh` (2,158★, pushed 2026-05-29) — `TerminalFeature/TerminalView.swift` is a *SwiftUI wrapper over SwiftTerm's UIKit TerminalView that receives bytes from a relay WebSocket* — i.e. **exactly the ttyd-style architecture you want, proven in a shipping native iOS app.**
  - `angristan/netclode`, `langwatch/kanban-code`, `aitjcize/Overlord` — all `UIViewRepresentable` SwiftUI wrappers.
  - These prove SwiftTerm is the correct *engine* for "stream a WebSocket into a terminal view" — but every consumer is native Swift; **none bridge it to RN.**
- **`SwiftTerm-RN` does not exist:** the commonly-guessed `migueravila/SwiftTerm-RN` returns **HTTP 404** [VERIFIED].
- **Risk verdict:** **MEDIUM-HIGH** *only as a build-it-yourself foundation* — the engine is low-risk and excellent, but (a) iOS only, (b) you must author + maintain the Fabric bridge yourself, (c) you still have no Android story. As an off-the-shelf RN dependency: **does not exist → unusable today.**

## Option 3 — `cawfree/react-native-terminal-component`

- **Repo:** https://github.com/cawfree/react-native-terminal-component — **16 stars**, 9 forks. npm: `react-native-terminal-component`.
- **Maintenance:** **ABANDONED** [VERIFIED] — created 2019-05-18, **last push 2019-05-20** (two days of activity, ~6 years dead). Not archived but effectively dead.
- **New Architecture support:** **NO / irrelevant.** It is a JS wrapper around rohanchandra's `javascript-terminal` — a pure-JS **in-memory** emulator with a fake filesystem and a handful of emulated `*nix` commands (`ls`, `cd`, `cat`…). It is **not** a real terminal: no PTY, no real shell, no connection to tmux/ttyd. No native code, so the New-Arch gate is moot.
- **Expo compatibility:** Would technically install (pure JS), but it cannot reach a real shell, so it's useless for ttyd/tmux parity.
- **Real working example:** A toy demo only.
- **Risk verdict:** **HIGH (disqualified)** — abandoned + not a real terminal (no PTY). Wrong category entirely.

## Option 4 — `jackpal/Android-Terminal-Emulator` (Android native engine — archived)

- **Repo:** https://github.com/jackpal/Android-Terminal-Emulator — **3,172 stars**.
- **Maintenance:** **ARCHIVED** [VERIFIED] — `archived: true`, last push 2022-01-01. Read-only, no further development.
- **New Architecture support:** **N/A** — it's a standalone Android **app** (Java) + a `term`/`emulatorview` module, **not** a React Native library and not a Maven-published reusable view. There is no RN/Fabric surface.
- **Expo compatibility:** None. Even using its `EmulatorView` would require forking decade-old Java and writing your own Fabric Android view wrapper.
- **Real working example:** The app itself (also `termoneplus` fork on F-Droid). No RN usage.
- **Risk verdict:** **HIGH (disqualified for RN)** — archived, Android-only, app-not-library. At most an Android-side reference if you build your own emulator view, paired with SwiftTerm on iOS.

## Option 5 — SSH-transport libraries (commonly mistaken for terminals): `react-native-ssh-sftp`, `react-native-ssh`

- **Repos:** `shaqian/react-native-ssh-sftp` (**66★**, last push **2023-01-25**); `azlyth/react-native-ssh` (**74★**, last push **2018-05-13**) [VERIFIED].
- **Maintenance:** ssh-sftp lightly maintained ~2023; react-native-ssh abandoned since 2018.
- **New Architecture support:** **NO / unknown** — both are old-architecture bridge modules (`react-native-ssh` predates Fabric by years; ssh-sftp has no Fabric/TurboModule conversion). Would need migration work and likely break under bridgeless mode on RN 0.83.
- **Expo compatibility:** Bare/dev-client only (native libssh2 bindings); no Expo config plugin.
- **What they actually are:** SSH/SFTP **transport** ("execute a command", "open a shell channel") — **not terminal emulators.** They give you a byte stream; they do **zero** VT100/ANSI parsing, no scrollback, no rendering. You'd still need a separate emulator (xterm.js in a WebView, or a hand-built renderer) on top. They solve the *transport* you already have via ttyd's WebSocket, not the *display*.
- **Real working example:** SSH login demos; no terminal-UI example.
- **Risk verdict:** **HIGH (wrong layer)** — not emulators; old-arch; only relevant if you abandon ttyd and do raw SSH, which adds work without solving rendering.

## Option 6 — `@fressh/react-native-xtermjs-webview` (explicitly a WebView — out of category, noted for completeness)

- **npm:** `@fressh/react-native-xtermjs-webview` (published ~2025-10).
- **What it is:** By its own description, *"a React Native WebView that embeds xterm.js with sensible defaults and a bridge for input and output."* This is the **WebView** approach, not native — it belongs to the sibling "WebView/xterm.js" report. Mentioned here only so it isn't mistaken for a native option. It does confirm the community consensus: when people need a real RN terminal, they wrap xterm.js in a WebView rather than go native.
- **Risk verdict (as a native option):** **N/A — disqualified by category** (it IS a WebView).

---

## Cross-cutting findings

- **The category is essentially a graveyard for *native* RN.** The only "RN native terminal" packages are either JS-only toys (Options 1, 3) or AI scaffolds with no shipped native code (Option 1). No one has published a working Fabric/TurboModule terminal-emulator native component for RN.
- **Explicit negative results for two requested search terms (the absence IS the finding):**
  - **`react-native-pty`** — **no such published RN package exists** [VERIFIED]. Searched npm and GitHub; no `react-native-pty` package, no PTY-spawning RN native module. (A mobile app cannot spawn a host PTY anyway — the PTY lives on the dev box behind ttyd; the device only needs transport + rendering, which is why this category is empty.)
  - **libvterm RN bindings** — **none exist** [VERIFIED]. `libvterm` (the C VT library behind Neovim) has no React Native / Fabric binding on npm or GitHub. No one has wrapped it for RN.
- **The good native engines exist but live outside RN.** SwiftTerm (iOS, alive, excellent) and historically jackpal's emulator (Android, archived) are the real engines — and the moment a developer wants a terminal *with a real shell over a socket*, they build a **native Swift app** (AgentsMesh, netclode, UTM) rather than an RN module. That is strong evidence that nobody has found it worthwhile to bridge a terminal engine into RN — the WebView route is "good enough" and cross-platform for free.
- **Two-platform tax.** Even a from-scratch native effort needs *two* engines (SwiftTerm on iOS + a custom/forked VT view on Android) behind one Fabric component, doubling the surface and the maintenance. xterm.js-in-WebView is one codebase for both.
- **New-Arch reality on SDK 55:** SDK 55 (RN 0.83, React 19.2, iOS 15.1+, Xcode 26.2 per Expo SDK 55 docs [VERIFIED via context7]) runs New Architecture only. Any native terminal component you author must be a Fabric component / TurboModule from day one — there is no legacy-bridge fallback to lean on, which further raises the cost of the build-it-yourself path.

## Recommendation

**Do not pursue a fully-native terminal-emulator library for the Expo SDK 55 mobile app. None exists that passes the New-Architecture gate, and building one is a multi-month, two-platform native project with no upstream to lean on.**

Concretely:
1. **Primary path: WebView + xterm.js** (see the sibling WebView report). It reaches terminal parity (interactive shell, scrollback, on-screen/hardware keyboard, copy/paste), reuses the existing ttyd WebSocket, and is one codebase for iOS + Android. This is what the ecosystem actually does (`@fressh/react-native-xtermjs-webview` is a ready example of the pattern).
2. **Respect the swappable-interface design constraint.** Define a `TerminalBackend` interface (e.g. `connect(url)`, `write(bytes)`, `onData(cb)`, `resize(cols,rows)`, `focus()`, `paste()`). Implement it first with the WebView/xterm.js backend. This guarantees that *if* a credible native option ever ships, it drops in behind the same interface with no app rewrite.
3. **Only if WebView proves inadequate** (e.g. unacceptable input latency or keyboard issues on a target device): the *least-bad* native route is a **bespoke Fabric component wrapping SwiftTerm on iOS** (proven engine, the AgentsMesh repo is a near-exact architectural template for "WebSocket bytes → SwiftTerm view") **plus a separate hand-built/forked Android VT renderer** — a large, owned, ongoing investment. Treat this as a contingency, not a plan. The `react-term`/`@next_term/core` VT parser (Option 1) is the only RN-oriented parser code to crib from, but it is unproven and ~3-star.

**Confidence: HIGH** that no off-the-shelf native option is viable on SDK 55 today (verified by direct inspection of every candidate's source tree and metadata, and a confirmed 404 for the rumored SwiftTerm-RN binding).
