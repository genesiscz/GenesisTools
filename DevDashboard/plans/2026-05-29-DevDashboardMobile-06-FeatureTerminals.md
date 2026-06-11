# 06 — Feature: Terminals (tmux / cmux / ttyd) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Read
> `…-00-Overview.md`, `…-ADR.md`, and `DevDashboard/research/06-terminal-recommendation.md` +
> `…/10-terminal-3rd-driver-recommendation.md` first. Work in the `feat/dev-dashboard-mobile`
> worktree. **Depends on 04** (app shell) **and 02** (Transport for the ttyd WS). **Standing rule:
> search docs on demand** (react-native-webview, @react-native-cookies/cookies, patch-package).

**Goal:** Interactive terminal parity with the web dashboard — open tmux/cmux sessions surfaced
through ttyd, with **two swappable WebView drivers + an in-app driver switcher**, a native mobile
key bar, scrollback, and crash-resilient reconnect.

**Architecture:** One `TerminalRenderer` interface (verified, from research 06) with two impls:
**Driver A** `WebViewTtydRenderer` (`react-native-webview` → existing `/ttyd/<id>/` URL, set via
**ref**, RNW 13.16.x + the **patch-package #3880** native diff for iOS New-Arch bug #3863, `dd_session`
cookie planted natively); **Driver B** `WebViewHtmlRenderer` (local xterm.js HTML + a self-opened WS
with the token in the WS subprotocol — **cribbing `@fressh/react-native-xtermjs-webview`'s bridge +
inlined-HTML + rAF/8KB coalescer + crash hooks**, MIT, NOT a hard dep). An in-app switcher (persisted
in `expo-sqlite/kv-store`) selects the active driver. **No 3rd driver** (research 10, HIGH conf):
native SwiftTerm is a deferred escape hatch behind the same seam; `ghostty-web` is an optional
renderer swap *inside* B. The sessions list + spawn/kill/attach come from the existing `/api`.

**Tech Stack:** react-native-webview, patch-package, @react-native-cookies/cookies, @xterm/xterm
(bundled for B), partysocket (WS), `@devdashboard/contract`, the `MobileKeyBar`.

**Definition of done:** On a real iOS dev-client, opening a tmux/cmux session shows a live shell in
Driver A (typing works, the key bar sends Ctrl/Esc/arrows, scrollback works); the switcher flips to
Driver B and it also opens a live shell; both survive a WebView content-process crash (auto-remount +
reattach); the `TerminalPage`/`SessionsPage` Appium specs pass.

---

## File Structure

**Create (under `DevDashboard/mobile/`):**
- `src/terminal/TerminalRenderer.ts` — the interface + shared types (from research 06).
- `src/terminal/WebViewTtydRenderer.tsx` — Driver A.
- `src/terminal/WebViewHtmlRenderer.tsx` — Driver B (+ `assets/xterm-host.html` cribbed from @fressh).
- `src/terminal/bridge.ts` — RN↔WebView message protocol (cribbed pattern).
- `src/terminal/registry.ts` — driver registry + active-driver selection.
- `src/terminal/MobileKeyBar.tsx` — native key bar (Ctrl/Esc/Tab/arrows/PageUp-Down/Paste/punct).
- `src/terminal/keymap.ts` — `TerminalKey` → escape-sequence mapping (pure, tested).
- `app/(tabs)/terminal.tsx` — the Terminal tab screen.
- `app/(tabs)/sessions.tsx` — the Sessions list (tmux/cmux/ttyd).
- `src/terminal/__tests__/keymap.test.ts`
- `patches/react-native-webview+13.16.x.patch` — the #3880 native diff.
- `e2e/pages/{terminal,sessions}.page.ts`, `e2e/specs/terminal.spec.ts`

**Modify:** `package.json` (postinstall `patch-package`), `src/state/settings.ts` (active driver).

---

### Task 0: Device spike gate (research-mandated — clear BEFORE building the rest)

> Research 06 §"device spike gate": confirm on a REAL iOS device, with #3880 patched, that (a)
> `/ttyd/<id>/` renders a live terminal and (b) `dd_session` cookie auth survives the WS handshake on
> cold launch. If (b) fails after the cookie-plant mitigation, **Driver B becomes the default** (token
> in WS subprotocol, no cookie). This task de-risks the whole plan.

- [ ] **Step 1: Throwaway spike screen** — a minimal `<WebView>` pointing at a known `/ttyd/<id>/`
  (spawn one via `tools dev-dashboard` + `tmux`), with the patch (Task 2) applied and the cookie
  planted (Task 3 Step 2). Load it on a physical iPhone via the dev-client.
- [ ] **Step 2: Record the result** in `DevDashboard/research/11-terminal-device-spike.md`: does the
  terminal render? Does the WS authenticate on cold launch? Latency feel for `nvim`/`tmux` redraw?
- [ ] **Step 3: Decide the default driver** (A if cookie auth holds; else B) and note it. Commit the
  spike notes. **Do not proceed to Task 5's default until this is recorded.**

```bash
git add DevDashboard/research/11-terminal-device-spike.md
git commit -m "spike(dd-mobile): iOS ttyd WebView + cookie-auth device spike result"
```

---

### Task 1: `TerminalRenderer` interface + shared types

**Files:** Create `src/terminal/TerminalRenderer.ts`.

- [ ] **Step 1: Copy the verified interface from research 06** (do not redesign)

```typescript
// Mirrors DevDashboard/research/06-terminal-recommendation.md §"swappable terminal interface".
export type TerminalKey =
    | "Escape" | "Tab"
    | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"
    | "PageUp" | "PageDown";

export type TerminalStatus = "idle" | "connecting" | "connected" | "disconnected" | "ended" | "error";

export interface TerminalCallbacks {
    onData?: (chunk: Uint8Array) => void;
    onStatus?: (status: TerminalStatus, detail?: string) => void;
    onExit?: (reason: "crash" | "remote-close" | "auth-failed" | "unknown") => void;
    onSelection?: (text: string) => void;
}

export interface TerminalSession {
    readonly id: string;        // ttyd session id (tmux/cmux surfaced through ttyd)
    readonly title?: string;
}

export interface TerminalRenderer {
    attach(session: TerminalSession, cb: TerminalCallbacks): Promise<void>;
    detach(): Promise<void>;
    sendInput(text: string): void;
    sendKey(key: TerminalKey, mods?: { ctrl?: boolean; alt?: boolean; shift?: boolean }): void;
    paste(text: string): void;
    scroll(lines: number): void;
    scrollPage(direction: -1 | 1): void;
    fit(): void;
    resize(cols: number, rows: number): void;
    focus(): void;
    readonly status: TerminalStatus;
}

export type TerminalDriverId = "webview-ttyd" | "webview-html"; // "native" reserved (escape hatch)
```

- [ ] **Step 2: Typecheck + commit**

Run: `bunx tsgo --noEmit | rg "terminal/TerminalRenderer"` → no errors.
```bash
git add DevDashboard/mobile/src/terminal/TerminalRenderer.ts
git commit -m "feat(dd-mobile): TerminalRenderer interface (renderer-agnostic seam)"
```

---

### Task 2: patch-package the react-native-webview #3880 native diff

> ADR §5 / research 06 §"#3863": on iOS New-Arch the `source` prop isn't forwarded → blank WebView.
> The 13-line #3880 diff fixes it; confirmed working on Expo 55. Sanctioned (custom native allowed).

**Files:** Create `patches/react-native-webview+<installed-version>.patch`; modify `package.json`.

- [ ] **Step 1: Install patch-package + add the postinstall hook**

```bash
bun add -d patch-package
```
`package.json`: `"scripts": { "postinstall": "patch-package" }`.

- [ ] **Step 2: Apply the #3880 edit to `node_modules` then capture the patch**

Edit `node_modules/react-native-webview/apple/RNCWebViewManager.mm` — give the empty `newSource`
custom-prop body the real implementation (verified diff from PR #3880):
```objc
RCT_CUSTOM_VIEW_PROPERTY(newSource, NSDictionary, RNCWebViewImpl) {
    if (json == nil) {
        [view setSource:@{}];
    } else {
        [view setSource:json];
    }
}
```
Then: `bunx patch-package react-native-webview`
Expected: a `patches/react-native-webview+13.16.x.patch` file is created.

- [ ] **Step 3: Verify the patch re-applies cleanly**

Run: `rm -rf node_modules/react-native-webview && bun install`
Expected: postinstall prints `Applying patches... react-native-webview@13.16.x ✔`.

- [ ] **Step 4: Commit**

```bash
git add patches/ DevDashboard/mobile/package.json
git commit -m "fix(dd-mobile): patch-package react-native-webview #3880 (iOS New-Arch source bug)"
```

---

### Task 3: Driver A — `WebViewTtydRenderer`

**Files:** Create `src/terminal/WebViewTtydRenderer.tsx`.

- [ ] **Step 1: Install the cookie module**

```bash
npx expo install @react-native-cookies/cookies   # v6.2.1 verified active
```

- [ ] **Step 2: Plant the `dd_session` cookie before mount, then render via ref**

> Auth: ttyd's WS is gated by the `dd_session` cookie (the front-proxy bridges the WS; browser WS
> can't send Authorization). Mint the cookie with a Basic-auth GET against the Agent, plant it with
> `@react-native-cookies/cookies`, `await` it, then mount the WebView with `sharedCookiesEnabled`.

```tsx
import CookieManager from "@react-native-cookies/cookies";
import { useRef } from "react";
import { WebView } from "react-native-webview";
import { useConnection } from "@app-mobile/state/connection";
import type { TerminalRenderer, TerminalSession, TerminalCallbacks, TerminalKey, TerminalStatus } from "./TerminalRenderer";

const PROPS = {
    keyboardDisplayRequiresUserAction: false, // most-missed: programmatic focus won't raise iOS kbd without it
    hideKeyboardAccessoryView: true,
    sharedCookiesEnabled: true,
    thirdPartyCookiesEnabled: true,
    domStorageEnabled: true,
    originWhitelist: ["*"],
    bounces: false,
    overScrollMode: "never" as const,
    automaticallyAdjustContentInsets: false,
    contentInsetAdjustmentBehavior: "never" as const,
};

// Mints + plants the dd_session cookie by doing a Basic-auth probe the Agent answers with Set-Cookie.
async function plantSessionCookie(baseUrl: string, authHeader: string): Promise<void> {
    const res = await fetch(`${baseUrl}/api/system/pulse`, { headers: { Authorization: authHeader } });
    const setCookie = res.headers.get("set-cookie");

    if (setCookie) {
        const value = setCookie.split(";")[0].split("=").slice(1).join("=");
        await CookieManager.set(baseUrl, { name: "dd_session", value, path: "/" });
    }
}
```
The renderer is a small class wrapping a `WebView` ref. `attach()` plants the cookie, sets
`status="connecting"`, then loads `source` **via the ref** (`webRef.current.injectJavaScript` after
an initial blank mount, OR remount via a `key` that changes on attach — research 06: the bug is
mixed update-vs-initial, so prefer remount-via-key). On `onLoadEnd` + a readiness probe of
`/ttyd/<id>/` → `status="connected"`. `sendKey`/`scroll` call `injectJavaScript` against the same
`.xterm-helper-textarea` + `window.__ddTtydScroll` the web `iframe-keys.ts`/`mobile-shell.ts` use
(they run in page context — easier than the cross-origin iframe path). `onContentProcessDidTerminate`
→ `onExit("crash")` + remount-via-key + re-`attach`.

- [ ] **Step 3: Reuse the existing key/scroll JS** — port the snippets from
  `src/dev-dashboard/ui/src/lib/iframe-keys.ts` (`dispatchKey` on `.xterm-helper-textarea`) and the
  `__ddTtydScroll`/`__ddTtydScrollPage` calls into `injectJavaScript` strings. The server's
  `injectTtydMobileShell` already defines `__ddTtydScroll` in the page, so A inherits it.

- [ ] **Step 4: Commit**

```bash
git add DevDashboard/mobile/src/terminal/WebViewTtydRenderer.tsx DevDashboard/mobile/package.json
git commit -m "feat(dd-mobile): Driver A — WebViewTtydRenderer (ttyd URL + cookie plant + ref source)"
```

---

### Task 4: Driver B — `WebViewHtmlRenderer` (crib @fressh, do NOT depend)

> Research 10: `@fressh/react-native-xtermjs-webview` (MIT, package-level LICENSE confirmed) IS
> Driver B pre-packaged, but its EXACT peer pins (`react@19.1.0`, `react-native-webview@13.15.0`)
> conflict with SDK 55 → **crib its bridge + inlined-HTML + rAF/8KB coalescer + crash hooks** under
> our controlled RNW 13.16.x; do not add it as a dependency.

**Files:** Create `src/terminal/bridge.ts`, `src/terminal/WebViewHtmlRenderer.tsx`, `assets/xterm-host.html`.

- [ ] **Step 1: Bundle xterm.js host HTML**

```bash
bun add -d @xterm/xterm @xterm/addon-fit   # build-time only; inlined into the HTML asset
```
Build `assets/xterm-host.html`: an `@xterm/xterm` + `addon-fit` page (NOT `addon-webgl` — research 06:
WKWebView WebGL is flaky). It listens for `message` events (bytes to `term.write`), posts user input
via `window.ReactNativeWebView.postMessage`, and exposes `__fit()`/`__scroll()`. Mark a clear
`// RENDERER SWAP POINT:` comment where `@xterm/xterm` → `ghostty-web` could be swapped later
(research 10; add `await init()` + verify WASM instantiates inline — single-threaded, no SAB needed).

- [ ] **Step 2: Bridge protocol (cribbed pattern)**

```typescript
// RN → WebView: dispatch a synthetic message event (the @fressh pattern).
export function injectBytes(base64: string): string {
    return `window.dispatchEvent(new MessageEvent("message",{data:${JSON.stringify(base64)}}));true;`;
}
// WebView → RN: onMessage carries { t: "data"|"ready"|"selection", ... }.
export interface BridgeMsg {
    t: "data" | "ready" | "selection" | "resize";
    payload?: string;
    cols?: number;
    rows?: number;
}
```

- [ ] **Step 3: Renderer + self-opened WS (token in subprotocol — no cookie dependency)**

`WebViewHtmlRenderer` mounts `source={{ html }}`, and on `attach()` opens the ttyd WS itself via
**partysocket** to `wss://<base>/ttyd/<id>/ws` passing the auth token as a **WS subprotocol**
(sidesteps the cookie). Incoming WS frames → `injectBytes`; WebView `onMessage` `data` → WS send.
Implements the rAF + 8 KB **coalescer** (cribbed) so redraw stays smooth. `onContentProcessDidTerminate`
/`onRenderProcessGone` → `onExit("crash")` + remount + reattach.

- [ ] **Step 4: Commit**

```bash
git add DevDashboard/mobile/src/terminal/bridge.ts DevDashboard/mobile/src/terminal/WebViewHtmlRenderer.tsx DevDashboard/mobile/assets/xterm-host.html DevDashboard/mobile/package.json
git commit -m "feat(dd-mobile): Driver B — WebViewHtmlRenderer (xterm.js HTML + WS subprotocol; cribbed @fressh bridge)"
```

---

### Task 5: Driver registry + in-app switcher

**Files:** Create `src/terminal/registry.ts`; modify `src/state/settings.ts`.

- [ ] **Step 1: Failing test — registry returns the selected driver**

```typescript
import { describe, expect, it } from "bun:test";
import { getRenderer, listDrivers } from "@app-mobile/terminal/registry";

describe("terminal registry", () => {
    it("lists both webview drivers", () => {
        expect(listDrivers().map((d) => d.id).sort()).toEqual(["webview-html", "webview-ttyd"]);
    });
    it("returns the requested driver instance", () => {
        expect(getRenderer("webview-html")).toBeDefined();
    });
});
```

- [ ] **Step 2: Implement the registry**

```typescript
import type { TerminalDriverId, TerminalRenderer } from "./TerminalRenderer";
import { WebViewTtydRenderer } from "./WebViewTtydRenderer";
import { WebViewHtmlRenderer } from "./WebViewHtmlRenderer";

interface DriverMeta { id: TerminalDriverId; label: string; make: () => TerminalRenderer; }

const DRIVERS: DriverMeta[] = [
    { id: "webview-ttyd", label: "ttyd (WebView)", make: () => new WebViewTtydRenderer() },
    { id: "webview-html", label: "xterm.js (WebView)", make: () => new WebViewHtmlRenderer() },
    // "native" (SwiftTerm Expo module) is a DEFERRED escape hatch — register here when built.
];

export function listDrivers(): DriverMeta[] {
    return DRIVERS;
}

export function getRenderer(id: TerminalDriverId): TerminalRenderer {
    const meta = DRIVERS.find((d) => d.id === id);

    if (!meta) {
        throw new Error(`unknown terminal driver: ${id}`);
    }

    return meta.make();
}
```

- [ ] **Step 3: Settings store + Settings UI toggle** — add `terminalDriver: TerminalDriverId` to the
  Zustand `settings` store, persist via `setPref("dd.terminalDriver", …)`, default from the Task 0
  spike. Add a "Terminal engine" picker in the More/Settings screen with `accessibilityLabel`
  `setting-terminal-driver`.

- [ ] **Step 4: Run test + commit**

Run: `bun test src/terminal/registry.test.ts` → PASS.
```bash
git add DevDashboard/mobile/src/terminal/registry.ts DevDashboard/mobile/src/terminal/registry.test.ts DevDashboard/mobile/src/state/settings.ts
git commit -m "feat(dd-mobile): terminal driver registry + in-app switcher"
```

---

### Task 6: MobileKeyBar + keymap

**Files:** Create `src/terminal/keymap.ts`, `src/terminal/MobileKeyBar.tsx` + keymap test.

- [ ] **Step 1: Failing test — keymap escape sequences**

```typescript
import { describe, expect, it } from "bun:test";
import { keyToBytes } from "@app-mobile/terminal/keymap";

describe("keymap", () => {
    it("maps Escape to \\x1b", () => { expect(keyToBytes("Escape")).toBe("\x1b"); });
    it("maps ArrowUp to CSI A", () => { expect(keyToBytes("ArrowUp")).toBe("\x1b[A"); });
    it("maps Ctrl+c to ETX (0x03)", () => { expect(keyToBytes("c", { ctrl: true })).toBe("\x03"); });
});
```

- [ ] **Step 2: Implement `keymap.ts`** (pure: `Escape`→`\x1b`, arrows→`\x1b[A/B/C/D`, Tab→`\t`,
  PageUp/Down→`\x1b[5~`/`\x1b[6~`, and `ctrl` letters → control codes `String.fromCharCode(c & 0x1f)`).

- [ ] **Step 3: `MobileKeyBar.tsx`** — a native RN bar above the keyboard (driven by RN `Keyboard`
  events + safe-area insets, replacing the web `visualViewport` approach). Buttons: **sticky Ctrl
  modifier**, Esc, Tab, arrows, PageUp/Down, **Paste** (Clipboard → `renderer.paste`), and common
  punctuation (`/ - _ | ~ : ` etc.). Each button → `renderer.sendKey`/`sendInput`. `accessibilityLabel`
  per key (`key-ctrl`, `key-esc`, …).

- [ ] **Step 4: Run test + commit**

Run: `bun test src/terminal/keymap.test.ts` → PASS.
```bash
git add DevDashboard/mobile/src/terminal/keymap.ts DevDashboard/mobile/src/terminal/MobileKeyBar.tsx DevDashboard/mobile/src/terminal/__tests__/keymap.test.ts
git commit -m "feat(dd-mobile): MobileKeyBar + keymap (Ctrl/Esc/arrows/paste)"
```

---

### Task 7: Sessions list (tmux / cmux / ttyd)

**Files:** Create `app/(tabs)/sessions.tsx`.

- [ ] **Step 1: Query sessions via the contract client** — `tmux.sessions()` (`/api/tmux/sessions`),
  `cmux.snapshot()` + `cmux.layout()`, `ttyd.list()`. Render a sectioned list (tmux sessions with
  their cmux/ttyd bindings, per `TmuxHubSession`). Each row → "Open" (spawn ttyd if needed via
  `ttyd.spawn({ tmuxSessionName })`, then navigate to the Terminal tab with that ttyd id) + "Kill"
  (`ttyd.kill`). Show `canAttachInTtyd`/`inCmux` flags.

- [ ] **Step 2: Create-session affordance** — `tmux.create()` / `cmux.createTerminal()`.

- [ ] **Step 3: `accessibilityLabel`s** (`session-row-<name>`, `btn-open-<name>`, `btn-new-session`)
  for Appium. Commit.

```bash
git add DevDashboard/mobile/app/\(tabs\)/sessions.tsx
git commit -m "feat(dd-mobile): sessions list (tmux/cmux/ttyd) + open/kill/create"
```

---

### Task 8: Terminal screen integration

**Files:** Modify `app/(tabs)/terminal.tsx`.

- [ ] **Step 1: Mount the active driver** — read `terminalDriver` from settings, `getRenderer(id)`,
  `attach({ id })` for the selected ttyd session, render the driver's WebView + the `MobileKeyBar`
  + scroll pads. Wire `onStatus`→a connection banner, `onExit`→reconnect UI. Use a Zustand store for
  the active session id.

- [ ] **Step 2: Reconnect/resync** — on `AppState` resume or `onExit`, re-`attach()` (tmux/cmux holds
  the session server-side; ttyd replays scrollback). Driver switch = `detach()` old + `attach()` new.

- [ ] **Step 3: Smoke on device** — open a session, type `ls`, hit Ctrl-C, scroll; flip the driver in
  Settings, confirm the other driver also opens a live shell. Commit.

```bash
git add DevDashboard/mobile/app/\(tabs\)/terminal.tsx
git commit -m "feat(dd-mobile): terminal screen — active driver + key bar + reconnect"
```

---

## Self-Review checklist

1. **Both drivers behind one interface** (`TerminalRenderer`), switchable in-app, defaulted from the
   Task 0 device spike. No 3rd driver (research 10); native seam reserved; ghostty-web swap point
   marked inside B.
2. **#3863 mitigated** (Task 2 patch + ref/remount in A); **cookie auth** planted natively in A;
   **B sidesteps cookies** via WS subprotocol.
3. **@fressh cribbed, not depended-on** (peer-pin conflict documented); xterm bundled build-time;
   no `addon-webgl` on iOS.
4. **Reuse:** A inherits the server's `injectTtydMobileShell`; key/scroll JS ported from
   `iframe-keys.ts`/`mobile-shell.ts`.
5. **Type consistency:** `TerminalRenderer`/`TerminalKey`/`TerminalDriverId` match the ADR + research
   06; contract client methods (`ttyd.*`, `tmux.*`, `cmux.*`) match plan 03.
6. **No placeholders** in code steps; the only explicit deferral is the native driver (escape hatch).

## Appium E2E (per ADR §8)

- **`e2e/pages/terminal.page.ts`** (`TerminalPage`): `open()`, `typeCommand(text)`, `pressKey(label)`
  (taps `~key-<label>`), `screenText()`, `switchDriver(id)` (via Settings).
- **`e2e/pages/sessions.page.ts`** (`SessionsPage`): `list()`, `openSession(name)`, `newSession()`.
- **`e2e/specs/terminal.spec.ts`:** open a session → terminal connects (status banner) → type a
  command, assert echo → tap `key-ctrl`+`c` → switch driver in Settings → reopen → assert the other
  driver also connects. **Feature is "done" only when this spec passes on the iOS dev-client.**

## Hand-off

Driver B's `ghostty-web` fidelity upgrade and the native SwiftTerm escape hatch are tracked as
**deferred** — build only if the Task 0 / Task 8 device spike shows WebView redraw latency is
unacceptable. The WS auth + reconnect details are owned by plan 02 (Transport).
