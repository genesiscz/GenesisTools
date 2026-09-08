---
name: macos-control
description: Inspect and operate macOS app UI with verified window targeting, current element references, and refreshed visual evidence. Covers native Computer Use when available, the independent tools control CLI, and optional Peekaboo recording. Use for native-app clicks, forms, UI inspection, screenshots and short transition recordings.
---

# macOS control

Honor the user's chosen tool. Native Computer Use, Peekaboo and `tools control` are different implementations with different reference formats. A working CLI or browser tool does not prove native Computer Use works.

## Choose the available provider

| Provider | Entry point | References | Requirements |
|---|---|---|---|
| Native Computer Use | `node_repl` JavaScript with `@oai/sky`, when exposed by the host | `element_index` from the latest `get_app_state` | Host-provided native runtime; not universally available |
| GenesisTools | `tools control see` then `tools control act` | Snapshot token plus an integer element index | macOS, Bun, Swift toolchain, Accessibility and Screen Recording |
| Peekaboo | Its own CLI or MCP tools | Opaque IDs and snapshot returned by its inspection | Installed Peekaboo and its permissions; check the actual tool schema/help |

`tools control` uses the repo's native `ax-tool`. It works in an ordinary terminal, Claude Code, Codex, and other agents that can run commands. It does not import Sky, require an OpenAI account, or require an agent session. Recording has a separate optional Peekaboo dependency.

If the user explicitly requests native Computer Use, first check for `node_repl`, not just a tool named `computer`. Importing Sky and listing apps proves connectivity only. Prove inspection, an authorized harmless action, and refreshed state before claiming it works. If unavailable, report the exact error and stop when the user has prohibited alternatives.

## Inspect, act, refresh

1. Inspect the intended app and exact window. Read the tree and view its screenshot when layout or visibility matters. Treat a permission error or an empty tree as unresolved, not evidence of empty data.
2. Select an element from that observation. Anonymous duplicate controls need an index, not a guessed label. Never translate indexes between providers.
3. Perform one logical action. Coordinate desktop input with other sessions. Do not run concurrent focus, typing, scrolling or recording work.
4. Refresh before choosing the next action. Verify the expected result in the new tree and, where AX is incomplete, the screenshot. A dispatch acknowledgment or exit code alone does not prove the UI changed.

If a focus attempt fails, inspect the intended app again. Do not capture whatever app became frontmost. Dynamic window titles, reordered windows, stale indexes and offscreen controls all require fresh observation. Do not blindly repeat an action after a timeout; it may already have happened.

## Native Computer Use when provided by the host

Read the host's Computer Use instructions before using its API. The following workflow was verified with native Sky; API availability still depends on the host.

In the `node_repl` JavaScript tool:

```js
var sky = (await import("@oai/sky")).sky;
var state = await sky.get_app_state({ app: "com.apple.calculator" });
nodeRepl.write(state.text);
```

Copy the observed index of the intended control into the next call. `observedIndex` below means that inspected index, never a fixed example number:

```js
await sky.click({ app: "com.apple.calculator", element_index: observedIndex });
var state = await sky.get_app_state({ app: "com.apple.calculator" });
nodeRepl.write(state.text);
```

To view the screenshot returned for that same window:

```js
if (state.screenshot) {
  await nodeRepl.emitImage({
    bytes: await (await import("node:fs/promises")).readFile(
      (await import("node:url")).fileURLToPath(state.screenshot.url)
    ),
    mimeType: "image/png",
  });
}
```

If `sky is not defined`, re-import and inspect again. If you lost the prior AX text or cannot interpret a diff, request `get_app_state({ app, disableDiff: true })`. Retry a failed display-name lookup using the app's bundle ID from `list_apps()`. Do not reset a functioning REPL, enable a guessed `cua_repl` server, or ask for a session restart just because another tool name is absent. A restart is warranted only when a concrete host configuration change requires it or the available runtime cannot recover.

## Independent CLI workflow

Check the installed command contract first:

```bash
tools control see --help
tools control act --help
```

Capture state into a file so the token does not need manual transcription:

```bash
tools control see \
  --app com.apple.calculator \
  --path /tmp/calculator.png > /tmp/calculator-state.json
tools json /tmp/calculator-state.json
```

Inspect the returned `elements` and view `screenshot.path`. If there are multiple windows, the command exits 1 with `windows` candidates and their current zero-based indexes. Re-run with `--window-index N`, choosing from those candidates. It never selects the largest window. The returned `window.id` is a CG window identity; it is not an element index or a window-list index. Refresh that same window with `see --app APP --window-id ID`, because focusing or closing windows can reorder their indexes. `--window-id` and `--window-index` are alternatives, not combined selectors.

After selecting the intended element, substitute its observed index for `N`:

```bash
tools control act \
  --app com.apple.calculator \
  --snapshot "$(jq -r .snapshot /tmp/calculator-state.json)" \
  --element N \
  --action press
tools control see \
  --app com.apple.calculator \
  --window-id "$(jq -r .window.id /tmp/calculator-state.json)" \
  --path /tmp/calculator-after.png > /tmp/calculator-after.json
tools json /tmp/calculator-after.json
```

This shell example needs `jq` only to read the token. Other clients can parse the JSON and pass it as a subprocess argument. Quote the token. Check each command's exit code before proceeding; do not use a pipeline that hides a failing action's exit status.

### Actions and boundaries

| `act --action` | Additional fields | Behavior |
|---|---|---|
| `get` | none | Read the exact indexed element after validation |
| `press` | none | Invoke the element's exposed AXPress; does not raise another window |
| `click` | optional `--double`, `--button` (`left`, `right`, `middle`) | Window-addressed mouse click at the element center or observed point; `--background` skips explicit activation |
| `drag` | `--to X,Y`, optional `--duration 0.1–5` | Left-button drag within the selected window; accepts `--coords` and `--background` |
| `set` | `--value TEXT` | Set AXValue and read it back; fails if not settable; no typing fallback |
| `perform` | `--ax-action NAME` | Invoke an exact action present in the observed actions list |
| `focus` | none | Explicitly activate and raise the selected window, then focus the selected element |
| `scroll` | `--direction` (`up`, `down`, `left`, `right`) | Wheel distance uses the receiving AX scroll-area viewport for `--pages 1–20` (default one), or exact `--pixels 1–10000`; accepts `--coords` and `--background`. Missing viewport requires explicit pixels |
| `type` | `--text TEXT` | Single-line Unicode typing into the focused element, limited to 256 UTF-16 code units; use `paste` for longer text |
| `select` | `--text MATCH` or `--range START,LENGTH` | Select a unique literal match or UTF-16 range; `--selection` (`text`, `cursor_before`, `cursor_after`) chooses selection or caret |
| `paste` | `--text PAYLOAD`, optional `--format` (`text`, `md`, `html`) | Paste at the current selection in the already focused input; clipboard restoration is best effort |
| `key` | `--keys cmd,a`, for example | One supported key plus modifiers, confined to the selected process and focused window |

Refresh after `focus`, too. `type` and `key` do not silently focus an input. Use an explicit key action to submit; embedded newlines in `type` are refused. Keyboard layouts and app event handling can vary, so verify the actual resulting text. `refreshRequired: true` means the action was dispatched, not that a business operation succeeded.

For `select --text`, optional `--prefix` and `--suffix` disambiguate the text immediately surrounding a match. They do not add content to a paste payload. Use `select → see → paste` to replace a chosen match or paste at its before/after caret. Selection options on `paste` are rejected. HTML paste also provides the raw markup as plain text; rich rendering depends on the receiving app. Clipboard restoration skips observed competing copies, but AppKit has no atomic compare-and-swap, so a narrow concurrent-copy race remains.

Snapshots expire after 120 seconds. Validation covers process start time, window identity, indexed tree contents, geometry, state and index bounds. The tree and screenshot come from the same window, and capture refuses changes observed during inspection. Truncated trees fail rather than issuing partial references; increase `--depth` up to 50 when needed. Offscreen, minimized or ambiguous window mappings fail explicitly.

This validates observable state, not permanent AX object identity or a lock on the desktop. Replacing or reordering fully identical anonymous controls with different hidden behavior cannot be detected. Client-local AX object hashes are excluded; standard window buttons are leaves so their decorative glyph animations do not invalidate references. Unsupported AX values are marked unreadable rather than fingerprinted from object addresses. Another process can still change the UI immediately after validation. Tokens are observation data, not credentials. Do not edit them, cache them for later plans, or treat them as an authorization mechanism.

### Click a point without moving the real mouse

Use `act --action click --background --coords X,Y` with a current snapshot. Coordinates are global screen points inside that snapshot's window; omit `--element` when using `--coords`. The target app's hit test must agree that the point belongs to the selected window. An overlapping window of the same app can therefore cause a refusal.

```bash
tools control act \
  --app Calculator \
  --snapshot "$(jq -r .snapshot /tmp/calculator-state.json)" \
  --action click \
  --background \
  --coords X,Y
```

Replace `X,Y` with the observed point. Element `x`/`y`/`width`/`height` are already global screen points. When using a screenshot pixel instead, convert its natural-size coordinates:

```text
screenX = window.x + imageX * window.width / screenshot.width
screenY = window.y + imageY * window.height / screenshot.height
```

This sends window-addressed mouse events to the target process without warping the pointer or explicitly activating the app. The receiving app may still respond by changing its own UI or focus; verify the result. Do not emulate pointer preservation by moving the real cursor away and restoring it afterward.

Current macOS requires a private CoreGraphics window-location setter for correct event routing. The tool checks that it exists before posting events and refuses the click if unavailable. This is a macOS compatibility constraint, not a Codex dependency. `press` remains the separate AX-action mechanism.

### Independent software cursor and browser tabs

`tools control cursor move` sends a window-addressed mouse-move event and saves its own named position. It never moves or restores the user's hardware pointer. `cursor click` uses that saved position; a refreshed token must belong to the same app launch and window. `cursor show` reads the saved state without operating the UI.

For browser tabs and toolbar controls, inspect with `--scope chrome`. This explicitly omits web-area descendants, keeping tab references stable while page content changes. Web-content coordinates require the default `window` scope. Repeated AX references are visited once using actual object equality, rather than treating equal hashes as equal objects.

```bash
tools control see \
  --app com.brave.Browser --window-id ID --scope chrome > /tmp/brave-state.json
tools control cursor move \
  --name brave --app com.brave.Browser \
  --snapshot "$(jq -r .snapshot /tmp/brave-state.json)" --coords X,Y
tools control see \
  --app com.brave.Browser --window-id ID --scope chrome > /tmp/brave-after-move.json
tools control cursor click \
  --name brave --snapshot "$(jq -r .snapshot /tmp/brave-after-move.json)"
tools control cursor show --name brave
```

Use the window ID and point from your observation. Movement can change hover state, so inspect again before clicking. An expired or changed snapshot refuses dispatch. The named cursor's saved position is independent of where the physical mouse currently sits.

The reproducible tab verification script uses these same `tools control` commands to click every visible tab in a supplied existing window, verify each selection, and restore the original tab. It refuses hidden tabs or an inventory change instead of declaring partial coverage complete. Its proof output contains ordinals and hardware-pointer measurements, not page titles or URLs:

```bash
bun src/control/scripts/brave-tabs.ts \
  --window-id ID --proof /tmp/brave-tabs-proof.json
```

### Existing commands

Existing selector commands and `tools control run` remain available. They do not acquire the `see`/`act` snapshot guarantees. In particular, `tools control snapshot` saves mouse/focus state for `restore`; it is unrelated to a `see` token. Do not pass new tokens or indexes to legacy commands. Inspect their own help before using them.

With the normal `tools` launcher, macOS grants generally belong to GenesisTools.app. Directly running `ax-tool` or Bun may use a different responsible process. Use the permission error to identify the missing grant; do not assume a terminal grant applies to every provider.

## Recording and publishing

For motion, read [references/capture.md](references/capture.md). Recording plans use the existing capture API, not `see` tokens. For explicit Peekaboo use, read [references/peekaboo.md](references/peekaboo.md) and check the installed help. For optional sharing, read [references/vitrinka.md](references/vitrinka.md). View local evidence before publishing it.

## Maintenance checks

From the GenesisTools repo, run the help-contract script after editing examples:

```bash
bun plugins/genesis-tools/skills/macos-control/scripts/check-help.ts
```

The native regression flow opens only a dedicated test app and requires desktop access:

```bash
bun src/control/scripts/live-smoke.ts
```

Run ordinary tests with `bun run test src/control` and native unit tests with `swift test --package-path native/ax-tool`. Never turn a failed live flow into a success claim by switching to an unrelated provider or discarding the refusal case.
