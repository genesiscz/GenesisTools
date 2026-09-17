# tools control

> **macOS UI automation through the Accessibility API, plus screen recording with timed actions.**

Drives native macOS apps by addressing real accessibility elements instead of guessing pixel coordinates. It also records the screen while it drives, which is how a UI change gets a video without anyone filming it.

---

## Snapshot-scoped inspection and actions

Start adaptive UI work with `tools control see --app APP`. It returns JSON with the selected window's stable CG ID, a PNG path, indexed AX elements and a short-lived snapshot token. Multiple windows require an explicit `--window-index` from the returned candidates; no largest-window fallback is used. Refresh the selected window with `--window-id` using its returned CG ID, since indexes reorder when focus changes. Do not combine both selectors.

`see` reads the whole tree in one `AXUIElementCopyHierarchy` round trip when that private call is available (`"bulk": true` in the output; `AX_TOOL_NO_BULK=1` forces the per-attribute walk, and chrome scope always walks). `act --refresh` settles and returns the post-action snapshot under `after`, so one call replaces `act` plus a second `see`; `--path <png>` names its screenshot. `see --since previous.json` returns the fresh token, window and screenshot with only the rows that were added or changed, plus a `changes` block with an old-to-new `indexMap`.

```bash
tools control see \
  --app Calculator \
  --path /tmp/calculator.png > /tmp/calculator-state.json
tools json /tmp/calculator-state.json
```

View the PNG, choose an element from `elements`, and pass that index and token to `act`:

```bash
tools control act \
  --app Calculator \
  --snapshot "$(jq -r .snapshot /tmp/calculator-state.json)" \
  --element N \
  --action press
```

Replace `N` with the observed index. Refresh with `see` after every action, including focus. `act --help` lists get, press, click, move, drag, set, perform, focus, scroll, type, key, select and paste. Foreground pointer actions require the exact window already focused; `--background` pointer actions retain geometry and hit-ownership checks without requiring focus. Keyboard/text input requires the intended input/window focused, and AX actions remain explicitly separate. Stale app instances, closed/wrong windows, changed observable trees, expired tokens and invalid indexes fail before dispatch. `ok: true` acknowledges dispatch, not the outcome of the user's task.

The screenshot and tree belong to the same window. Indexes are specific to that observation, not persistent AX object identities. Replacement or reordering of completely indistinguishable anonymous controls cannot be detected. Standard window buttons exclude decorative glyph descendants. Unsupported AX values are marked unreadable. The tool cannot lock out concurrent desktop changes; inspect errors and refresh rather than replaying automatically.

The wrapper accepts native output up to 32 MiB per stream. Exceeding that budget fails explicitly and never retries an action automatically; execution may already have partially completed. Use a smaller observation depth or the explicit browser-chrome scope for large trees, and refresh before deciding what to do next.

This workflow uses native `ax-tool` with macOS APIs, not Codex, Sky or Peekaboo. A shell, Bun, Swift, and the relevant macOS grants are sufficient. The normal launcher attributes permissions to GenesisTools.app; directly invoking the binary can have a different responsible process. The CLI rebuilds when its native sources change. Direct native callers should run `swift build --package-path native/ax-tool -c release` after source changes.

`see` tokens are unrelated to the legacy mouse/focus `snapshot` and `restore`. Existing selector commands, sequential plans and recording plans retain their existing semantics and do not accept the new snapshot contract.

Validation:

```bash
bun run test src/control
swift test --package-path native/ax-tool
bun src/control/scripts/live-smoke.ts
bun plugins/genesis-tools/skills/macos-control/scripts/check-help.ts --repo .
```

The live smoke opens a dedicated two-window test app and terminates only that app. It requires desktop access; ordinary tests do not operate personal apps. Add `--peekaboo` to the help check when validating the optional recording provider.

## Legacy discovery and recording preflight


```bash
tools control apps                          # valid --app values
tools control preflight --app Genesis
```

One `preflight` call returns screens with their scale and origins, the frontmost app, windows with phantom strips flagged, the element inventory grouped by role, the browser tab, a units reminder, and a suggested plan. Doing this first is not politeness, it is what stops you from clicking at coordinates that belong to a different screen scale.

`tools control apps` is how you discover valid `--app` values (name, pid, bundleId).

---

## Command groups

### Discovery, read-only

| Command | Description |
|---------|-------------|
| `doctor` | Accessibility, Screen Recording and Automation as three lines, each granted / denied / not determined, with the identity that needs it (GenesisTools.app). Read-only; exits 1 while something is missing. |
| `audit` | Which running apps carry `AXManualAccessibility` (control sets it) or `AXEnhancedUserInterface` (control never does), read live without touching them; every grant with its holder; which binary each capability runs through. `--json` for machines. |
| `preflight` | Run this first. Screens, frontmost app, windows, elements by role, browser tab, suggested plan. |
| `apps` | List running apps, the valid `--app` values |
| `list` | List AX elements in an app: identifiers, roles, values |
| `tree` | Hierarchical tree dump of AX elements as nested JSON |
| `dump` | Windows plus every on-screen element with scroll-clip visibility |
| `find` | Search for elements |
| `attrs` | List all attributes and values of an element |
| `actions` | List available AX actions on an element |
| `get` | Read attributes of an element |
| `hittest` | Which element the system actually delivers a click at this screen point to |
| `typography` | Rendered font name, size and sRGB rgba for every static text, for contrast and size checks |

❗ **When `--title` finds nothing, try `--desc` or `--q`.** Many apps, including Chromium browsers and SwiftUI, expose their visible text through `AXDescription` rather than `AXTitle`. This is the single most common reason a search comes back empty.

### Acting

| Command | Description |
|---------|-------------|
| `focus` | Activate an app, and optionally focus a specific element |
| `press` | Press an element via AXPress |
| `click` | CGEvent click at the element centre, or an observed global point with background delivery |
| `perform` | Perform any AX action on an element, the generic form of `press` |
| `set` | Set the value of a text field |
| `type` | Type keystrokes and hard-verify the result |
| `hotkey` | Send a key combo via CGEvent |
| `scroll` | Legacy wheel scrolling with `--direction` and `--amount`, or scroll an element into view without direction. Snapshot-scoped `act --action scroll` has its own page/pixel options below |
| `window` | Get window bounds and state, or mutate with `--action move\|resize\|minimize\|maximize\|close\|focus` |

⚠️ **`type` inserts at the current cursor.** Use `--end` to jump to the end of the field first, or `--clear` to replace the whole field. Without either, you get text spliced into the middle of whatever was there.

⚠️ **`hotkey --app` activates the target first and refuses if it cannot become frontmost.** That refusal is a feature: a key combo delivered to the wrong app is worse than a failure.

### Capturing

| Command | Description |
|---------|-------------|
| `screenshot` | Window screenshot via CGWindowList. `--annotate` draws numbered boxes on interactable elements and returns a legend. |
| `ocr` | Vision OCR over an app window or `--image` file. Returns text blocks with pixel bounding boxes. |
| `draw <image>` | Draw annotations onto an existing image from a JSON plan |
| `compare-screenshot <a> <b>` | Pixelmatch two images: mismatch count and percentage, similarity score, optional diff PNG |
| `capture` | Screen recording with timed UI actions, crop compositing and vitrinka publish. Records natively through `ax-tool capture` (ScreenCaptureKit) when the binary is built; `capture.backend: "peekaboo"` or a native start failure selects Peekaboo. |

`screenshot --window` **fails loud on zero or two-plus title matches**, and unscoped picks the largest window. Failing on an ambiguous match is deliberate: silently shooting the wrong window wastes far more time.

`compare-screenshot` exit codes: `0` within `--max-mismatch` (or no gate), `1` over it, `2` unusable inputs such as a dimension mismatch without `--resize-to-match`.

`draw` works on **any** capture source, including playwright and `screencapture`, because annotation is pure post-processing. Coordinates are natural image pixels. Annotation kinds: `highlight` (rounded-rect outline), `box`, `ellipse`, `arrow`, `label`, `blur` (redact), `crop` (applied last), and `grid` as a coordinate finder.

### Plans

| Command | Description |
|---------|-------------|
| `run <plan>` | Execute a plan file |
| `record-plan` | Record a plan instead of writing one |
| `wait` | Wait for an element condition |
| `assert` | Assert an element condition |
| `snapshot` | Capture the current mouse position and focused element |
| `restore` | Restore a snapshot |
| `build` | Build a plan |

---

## The plan contract

One schema covers sequential steps, timed timelines and recordings.

```json
{
  "app": "Genesis",
  "restore": true,
  "delayMs": 300,
  "exact": false,
  "capture": {},
  "steps": [
    { "do": "focus" },
    { "do": "press", "q": "Chat" },
    { "do": "click", "desc": "Account", "role": "button" },
    { "do": "set", "id": "field-id", "value": "hello" },
    { "atMs": 2000, "do": "screenshot", "path": "/tmp/shot.png" },
    { "do": "hotkey", "keys": "cmd,w" },
    { "do": "wait", "q": "Save", "gone": true },
    { "do": "assert", "id": "status", "contains": "Done" }
  ]
}
```

The mode is decided by the plan, not by a flag:

- **no `atMs` anywhere**: sequential. Each step runs, with `delayMs` between them.
- **any step has `atMs`**: timeline. Steps fire at their offset from the start, and steps without `atMs` run back-to-back after the previous one.
- **`capture` present**: the entire plan goes to the capture runner, and `steps` is accepted as an alias for its `actions`.

Step fields: `do`, `atMs`, `q` (universal search), `id`, `role`, `title`, `desc`, `subrole`, `window`, `value`, `text`, `path`, `keys`, `action`, `crop`, `delay`, `app` (override). `wait` and `assert` additionally take `gone`, `for` (`"enabled"` or `"focused"`), `expect`, `contains`, `timeout` and `interval`.

Roles and subroles are fuzzy by default, so `"button"` matches `AXButton`. `exact: true` forces strict matching. Action aliases `ax-set`, `ax-press` and `ax-perform` map to `set`, `press` and `perform`.

**Result semantics:** the top-level `ok` is true only when *every* step succeeded. `failedSteps` carries the count, and `steps[]` carries per-step results, each with its own result JSON and wall-clock timing in ms.

`restore: true` snapshots before the run and restores afterward, which is what keeps a plan from leaving your mouse and focus somewhere strange.

## Recording a plan instead of writing one

```bash
tools control record-plan start --record all
# ...run commands, or drive the UI by hand...
tools control record-plan stop --out plan.json
tools control record-plan status

# one-shot: record 20 seconds of real activity, then emit the plan
tools control record-plan --record activity --duration 20 --out plan.json
```

Modes for `--record`:

- **`commands`**: logs every subsequent `tools control` *action* command (`press`, `click`, `set`, `type`, `hotkey`, `scroll`, `perform`, `screenshot`, `window`, `focus`) from **any** terminal until stop. Read-only commands (`get`, `find`, `attrs`, `preflight`) are intentionally not recorded.
- **`activity`**: records your real clicks, keys and scrolls through a CGEvent tap, resolving clicks to AX elements (id, desc, role) so they are replayable.
- **`all`**: both, deduped. This is the default.

---

## Permissions

Every grant belongs to **GenesisTools.app** (`com.genesiscz.genesistools`), not to the terminal and not to a helper binary. `tools control` re-enters through the app launcher for every native spawn: `ax-tool` (Accessibility, Screen Recording), `peekaboo` in its local runtime, and `osascript` (Automation). Grant each pane once to GenesisTools and every terminal, editor and agent host shares it.

```bash
tools control doctor            # three grants, three lines, exit 1 while one is missing
tools control audit             # plus: which apps carry AXManualAccessibility / AXEnhancedUserInterface, and what runs through what
tools macos permissions open --pane accessibility
```

A missing Accessibility grant is reported as a distinct error (`"reason": "accessibility-not-granted"`) naming GenesisTools.app and the pane. It is never reported as `no windows for <app>`: that message is reserved for a query that succeeded and returned an empty list. An app that does not answer the AX query at all gets its own message (`accessibility query failed ... kAXErrorCannotComplete`).

Two things stay outside GenesisTools.app, and `audit` says so:

- The Peekaboo **bridge** transport (the default when `capture.backend: "peekaboo"` runs without `noRemote`) is the Peekaboo.app daemon, `boo.peekaboo.mac`, and uses that app's own grants. Set `capture.noRemote: true` to stay on the local runtime, which the launcher covers.
- A `darwinkit serve` process on the machine belongs to other tools (calendar, reminders, mail). `tools control` does not use DarwinKit for anything.

⚠️ `tools control <anything> --app X` writes `AXManualAccessibility = true` into X, because Chromium and Electron build no AX tree until an assistive client asks. Nothing clears it; only relaunching X does. `AXEnhancedUserInterface` is deliberately never set (it changes AppKit layout), so when `audit` finds it on, another client set it.

⚠️ If the launcher is off (`GENESIS_TOOLS_NO_APP=1`, or `tools macos permissions disable`), grants follow whatever process launched `tools`, and a runtime upgrade (a new `bun` binary) silently revokes them because that grant is per-binary. `doctor` names that process.

## Notes

- `tools macos control` reaches the same functionality through the macOS umbrella tool.
- The `macos-control` skill wraps this tool with the discovery-first workflow and the frame-by-frame review loop for recordings.
- `hittest` is the tie-breaker when a click "works" but the wrong thing responds. It reports which element the system would actually deliver the event to, which is not always the element you targeted.

### Independent software cursor

`cursor move --app APP --snapshot TOKEN --coords X,Y --name NAME` moves a named software cursor through a process-targeted mouse-move event. It saves its own coordinates without moving the hardware pointer. `cursor show --name NAME` reads that position; `cursor click --name NAME --snapshot FRESH_TOKEN` clicks it. Fresh tokens must match the saved app launch and window. Stale tokens fail natively, and failed moves do not overwrite cursor state.

For browser tab strips and toolbars, `see --scope chrome` omits web-area descendants explicitly. The token remembers that scope and cannot be used to dispatch pointer events inside omitted web content. Use the default `window` scope to inspect and operate page content.

```bash
tools control see \
  --app com.brave.Browser --window-id ID --scope chrome > /tmp/brave-state.json
tools control cursor move \
  --app com.brave.Browser --name brave \
  --snapshot "$(jq -r .snapshot /tmp/brave-state.json)" --coords X,Y
# Refresh after movement before choosing the click.
tools control see \
  --app com.brave.Browser --window-id ID --scope chrome > /tmp/brave-next.json
tools control cursor click \
  --name brave --snapshot "$(jq -r .snapshot /tmp/brave-next.json)"
```

`bun src/control/scripts/brave-tabs.ts --window-id ID --proof /tmp/brave-proof.json` verifies every visible browser tab through the real CLI, compares hardware-pointer positions, and restores the initial tab. It does not click page controls or submit forms. Hidden tabs and a changed tab inventory cause a failure rather than partial-success reporting.

### Snapshot drag, selection and paste

`drag` uses the left mouse button and accepts `--to X,Y`, `--duration 0.1..5`, `--coords` and `--background`. `click --button left|right|middle` selects a mouse button for clicks. Background drag and right-click passed the dedicated AppKit fixture; receiving apps must accept background events. The tool does not explicitly activate or raise the app, but an app may change its own key window in response.

`scroll --direction up|down|left|right` uses viewport-sized wheel distance with `--pages 1..20` (default one), or an exact distance with `--pixels 1..10000`. These are mutually exclusive. Both modes accept `--coords` and `--background`. Page mode uses the nearest receiving AX scroll area's viewport at the verified point, including when targeting a child row. If that viewport cannot be established, the command refuses and requests explicit `--pixels`.

`select` accepts a UTF-16 `--range START,LENGTH` or a unique literal `--text MATCH`. With a literal match, `--prefix` and `--suffix` disambiguate its immediate surroundings. `--selection text|cursor_before|cursor_after` chooses the selected range or caret. These options belong only to `select`.

`paste --text PAYLOAD --format text|md|html` pastes at the focused input's existing selection. To choose another range or caret, use `select → see → paste`. Prefix/suffix do not modify the paste payload, and selection flags on `paste` are rejected. `type` is limited to single-line text of at most 256 UTF-16 code units; use paste for longer text.

Clipboard restoration checks ownership and skips observed competing copies. It is best effort because AppKit has no atomic compare-and-swap; a narrow concurrent-copy race remains. HTML paste also carries raw markup as its plain-text representation, so rendering depends on the receiver.

## Jev semantic control

`resolve` and `judge` inspect a native window without dispatching. Both accept `--provider vercel|typesafe`, `--window-id`, `--scope window|chrome`, and `--snapshot-file` for a retained full `see` observation.

```sh
tools control resolve --app TextEdit --intent "the settings button for this account" --provider typesafe
tools control judge --app TextEdit --expect "the export finished successfully"
tools control judge --app Fixture --expect "counter is one" --exact-id counter --exact-value 1
```

Targets come from observed AXPress actions or writable text fields, with ancestor context. Disabled/hidden targets and secure fields are excluded. Unknown or uncertain choices abstain. Resolution returns the native snapshot token and selected element without execution.

Judging reports verified/refuted/unknown, evidence IDs, probabilities and its semantic or exact basis. A button label is not completion evidence. Conflicting failure evidence blocks success. Exact ID/value readback does not call the model. A semantic verdict is a model judgment, not independent proof of hidden application state.

Requests contain window/candidate labels and redacted observation text; writable input values stay local. The model cannot construct action arguments or bypass native snapshot freshness and app/window validation.
