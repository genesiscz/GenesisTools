# tools control

`tools control` automates native macOS apps through the Accessibility (AX) API, records the screen while it acts,
and checks what happened. It addresses real accessibility elements instead of guessed pixel coordinates, so a script
or an agent can press a button, fill a form, read a menu or record a demo of a UI change without anyone filming it.
The same core drives a booted iOS Simulator, and the optional Jev commands add bounded AI choices on top.

## Quick start

```bash
tools control doctor                 # are Accessibility, Screen Recording and Automation granted?
tools control apps                   # the valid --app values (name, pid, bundle id)

# Observe one window: indexed AX tree, a PNG and a snapshot token valid for 120 s
tools control see \
    --app Calculator \
    --path /tmp/calc.png > /tmp/calc.json

# Press element 12 of that observation, then return the fresh tree under `after`
tools control act \
    --app Calculator \
    --snapshot "$(jq -r .snapshot /tmp/calc.json)" \
    --element 12 \
    --action press \
    --refresh

tools control screenshot --app Calculator --path /tmp/shot.png        # one window, no tree walk
tools control capture record --include-app Calculator --duration 4     # record that app's windows
```

Replace `12` with an index you read from `elements` in the `see` output. Run `see` again after every action.

## Commands

Every command takes these global options: `--provider vercel|typesafe` (the Jev provider for this call), `--no-cursor`
(no animated cursor feedback), `--note <text>` (a reason shown on the cursor label), `-v` and `--readme`. Run
`tools control <command> --help` for the full flag list of any command.

### Inspect and act on one window (start here)

| Command | What it does |
|---|---|
| `see` | One window as JSON: indexed AX tree, PNG, window CG ID, snapshot token (120 s). Never activates the app. |
| `act` | Act on an element of a `see` snapshot after it checks app instance, window, age and tree. Never retries. |
| `statusitems` | Every running app's menu bar status items: owner, bundle id, pid, `element`, title, frame. |
| `hittest --at X,Y` | Which element the system really delivers a click at this screen point to (no `--app`). |

`see` flags: `--app` (name, bundle ID or PID, required), `--window-index <n>`, `--window-id <id>`,
`--window-title <substring>`, `--depth <n>|auto` (default 20), `--truncate`, `--scope window|chrome|menu|extras`,
`--menu <title>`, `--query <text>`, `--query-role <role>`, `--path <png>`, `--no-image`, `--perception ocr`,
`--perception-crop x,y,w,h`, `--perception-width <px>`, `--since <previous.json>`.

`act --action` is one of `get`, `press`, `hover`, `click`, `move`, `drag`, `set`, `perform`, `focus`, `scroll`,
`type`, `key`, `select` and `paste`. Its other flags are described in [The see and act contract](#the-see-and-act-contract).

### Read-only discovery (selector commands)

| Command | What it does |
|---|---|
| `apps` | Running apps, the valid `--app` values. `--all` adds background and agent processes. |
| `preflight` | Run this first: screens with scale, windows, elements by role, a suggested plan (details below). |
| `list` | AX elements of an app: identifiers, roles, values (`--depth`, default 10). |
| `tree` | The AX tree as nested JSON (`--depth`, default 10). |
| `find` | Search elements by `--role`, `--title`, `--value`, `--desc`, `--subrole`, `--text` or `--q`. |
| `attrs` | Every attribute and value of one element. |
| `actions` | The AX actions one element supports. |
| `get` | Read attributes of one element. |
| `dump` | App-wide: windows plus every on-screen element with scroll-clip visibility. |
| `typography` | App-wide: rendered font name, size and sRGB rgba of every static text, for contrast checks. |
| `window` | Window bounds and state; with `--action` it moves, resizes, minimizes, maximizes, closes or focuses. |

`attrs`, `actions`, `get`, `focus`, `press`, `perform`, `click`, `set`, `type`, `scroll`, `wait` and `assert` share
one element selector: `--app` (required), `--id`, `--role`, `--title`, `--desc`, `--subrole`, `--q` (universal
search over id, title, desc, value, role and subrole), `--window <title>`, `--exact` (strict role matching; the
default is fuzzy, so `button` matches `AXButton`), `--depth <n>` (default 15), `--json` and `--pretty`. `find` takes
the same set without `--id` and adds `--value` and `--text`. The other discovery commands have their own sets:

- `list` and `tree`: `--app`, `--depth` (default 10), `--json`, `--pretty`.
- `dump` and `typography`: `--app` and `--pretty`.
- `apps`: `--all`, `--json`, `--pretty`.
- `window`: `--app`, `--window`, `--action`, `--x`, `--y`, `--width`, `--height`, `--no-raise`, `--json`, `--pretty`.
- `preflight`: `--app`, `--depth` (default 10), `--wanted screens,frontmost,windows,elements,browser,plan` (or
  `elements:<Role>` for the full dump of one role; by default elements are cut to 15 per role), `--save <path>` for
  the suggested plan, `--json` and `--pretty`.

One `preflight` call returns the screens with their scale and origins, the frontmost app, the windows with phantom
strips flagged, the elements grouped by role, the browser tab, a units reminder and a suggested plan. Run it first:
it is what stops a click at coordinates that belong to a screen with another scale.

### Selector actions

| Command | What it does |
|---|---|
| `focus` | Activate the app and optionally focus one element. `--no-activate` focuses it without raising the app. |
| `press` | AXPress an element. |
| `perform --action <AXName>` | Any AX action (`AXShowMenu`, `AXRaise` and so on), the generic form of `press`. |
| `click` | A CGEvent click at the element centre. |
| `set --value <text>` | Set the value of a text field. |
| `type --text <text>` | Type keystrokes and read the result back. `--clear`, `--end`, `--return`, `--delay` (8 ms), `--to-pid`. |
| `hotkey --keys <combo>` | Send a key combo through CGEvent. `--app` activates the target first. `--hold`, `--to-pid`. |
| `scroll` | Wheel scrolling with `--direction`, or scroll an element into view without it. |
| `window --action <name>` | `move` (`--x --y`), `resize` (`--width --height`), `minimize`, `maximize`, `close`, `focus`; `--no-raise`. |

`set`, `type` and `hotkey` also take `--steal-focus`. See [Selector command gotchas](#selector-command-gotchas).

### Plans, waits and replays

| Command | What it does |
|---|---|
| `run [plan]` | Run a plan file, `-` for stdin, or `--plan '<json>'`. `--stop-on-fail`, `--dry-run`, `--steal-focus`. |
| `wait` | Poll until an element condition holds (`--for`, `--expect`, `--contains`, `--gone`; `--timeout` 5000 ms). |
| `assert` | Check an element condition now, so a plan becomes a UI test. |
| `snapshot` | Save the mouse position and the focused app and window as JSON. |
| `restore --snapshot <json>` | Put the mouse and focus back from a `snapshot`. |
| `record-plan [action]` | Record a plan instead of writing one: `start`, `stop`, `status`, `capture`, or one shot. |
| `workflow run [plan]` | A versioned see/act plan in one pinned window, a fresh postcondition per step, one deadline. |
| `replay-plan <file>` | Replay a versioned semantic plan against fresh observations. |

### Screenshots, OCR and before/after

| Command | What it does |
|---|---|
| `screenshot` | A window screenshot through CGWindowList. `--annotate` draws numbered boxes and returns a legend. |
| `ocr` | Vision OCR of an app window or `--image <file>`: text blocks with pixel bounding boxes. |
| `draw <image> --annotate <json-or-path>` | Draw annotations from a JSON plan (inline or a file) onto any image. |
| `compare-screenshot <a> <b>` | Pixelmatch two images: mismatch count and percentage, similarity, optional diff PNG. |
| `compare-tree <before> <after>` | Diff the view trees of two GenesisTools hub shots taken with `--snapshot-tree`. |
| `report <input>` | An annotated before/after report from a shot list JSON or a folder of `<stem>-before` and `<stem>-after`. |

### Recording (`capture`)

| Command | What it does |
|---|---|
| `capture run <plan.json>` | Record, fire timed actions, crop, optionally publish. `--annotate` draws on each frame. |
| `capture record` | Record only selected windows or apps through ScreenCaptureKit. |
| `capture session` | A recording you control while it runs: JSONL commands on stdin, JSONL events on stdout. |
| `capture targets` | What a session can record: on-screen windows, their apps and the displays. |
| `capture recrop <result> <plan>` | Re-crop the frames of a finished run without recording again. |
| `capture preflight` | Run this first when you write a capture plan: screens, windows in points and frame pixels, a plan skeleton. |
| `capture clickmap --app <name>` | A window screenshot with a grid in global screen points, to find web-page click points. |

`run` is the default subcommand, so `tools control capture plan.json` is the same as `capture run plan.json`.

### Jev semantic control (paid AI calls)

| Command | What it does |
|---|---|
| `resolve --intent <text>` | Read-only: which observed target matches an intent. |
| `judge --expect <text>` | Read-only: is an outcome verified, refuted or unknown, with evidence. |
| `choose --intent <text>` | Read-only exact, Jev or auto choice; uncertainty returns an evidence packet. |
| `observe --goal <text>` | Five Jev questions over one `see` in a single request. |
| `assist --goal <text>` | Run bounded observed AXPress actions until the postcondition is verified. |
| `fill --data <file>` | Fill named string values, verify exact readback, never submit. |
| `await --condition <text>` | Wait for exact local readback or Jev readiness. |
| `sequence <intent>` | Resolve one bounded target set through Jev and press it in a persistent native session. |
| `visual --intent <text>` | Native OCR choice with one-use screenshot evidence; `--click` dispatches one click. |
| `replay [case]` | Replay retained decisions with zero desktop actions (`--list`, `--chooser exact\|mock\|jev`). |
| `wait-replay [case]` | Replay semantic waits on a virtual clock (`--list`, `--chooser oracle\|jev`). |
| `compare-choosers` | Compare exact, Jev and auto on a fixed synthetic corpus; never dispatches. |
| `resilience-replay <case>` | Replay the `stale`, `unknown`, `permission`, `cap`, `reordered`, `renamed` or `ambiguous` fixture. |

### iOS Simulator (`sim`)

| Command | What it does |
|---|---|
| `sim devices` | Available simulators and which are booted. |
| `sim launch --bundle-id <id>` | Launch an app, or bring a running one to the front. `--udid` when several are booted. |
| `sim see` | Read the screen as addressable, labelled elements. `--out <file>` saves it for `sim act`. |
| `sim act --snapshot-file <file> --element <n>` | Act on one observed element against a fresh read, with readback. |
| `sim screenshot --path <png>` | A PNG of the simulator screen. |

### Software cursors and the cursor overlay

| Command | What it does |
|---|---|
| `cursor preview --coords X,Y` | Show the animated feedback at a global point, with no input sent. |
| `cursor hide` | Hide the feedback overlay; no pointer moves. |
| `cursor move` | Move a named software cursor inside the exact window of a fresh snapshot. |
| `cursor show` | Show a saved software cursor's state. |
| `cursor click` | Click at a saved software cursor through its window, without moving the hardware pointer. |

### Computer Use aliases

| Command | What it does |
|---|---|
| `prepare` | Compile the native backend before latency-sensitive work (`tools computer-use prepare`). |
| `mcp` | The native Computer Use MCP server over stdio; `--repl` preloads `computer` in a JS/TS REPL. |
| `computer-run [code]` | Run JS/TS with the `computer` API preloaded (`--file`, `--timeout` 30000 ms, `--json`). |

### Setup, permissions and settings

| Command | What it does |
|---|---|
| `doctor` | Each grant as granted, denied or not determined, with its identity. Read-only, never prompts. |
| `audit` | Apps with `AXManualAccessibility` or `AXEnhancedUserInterface` set, each grant's holder, each binary. |
| `permissions request` | Ask macOS for Accessibility and Screen Recording, open each pane, wait up to 120 s per grant. |
| `build` | Build or rebuild the native `ax-tool` binary. |
| `osascript [script]` | Run AppleScript or JXA as GenesisTools.app, so it uses the app's Automation grants. |
| `config show\|set\|unset` | Saved Jev and control defaults. See [Configuration](#configuration). |

`doctor` and `audit` are read-only and never prompt. `doctor` exits 1 while a grant is missing. `audit` reads the
running apps live, without touching them. Both take `--format table|json` or `--json`; `audit --all` adds
background-only processes.
`osascript` takes `-l AppleScript|JavaScript`, `-f <file>`, `-e <line>` (repeatable), `--timeout <s>` (default 60)
and `--json`.

## The see and act contract

`see` and `act` are the validated way to drive a window. They are unrelated to the legacy `snapshot` and `restore`,
and the selector commands, `run` plans and recording plans keep their own semantics and do not accept a `see` token.

### Choosing the window

`see --app APP` returns the selected window's stable CG ID, a PNG path, indexed AX elements and a short-lived
snapshot token. When the app has several windows, `see` refuses and lists candidates: pass `--window-index` from
that list, or `--window-title <substring>` (zero or two or more matches exit 1 with the candidates). There is no
largest-window fallback. Refresh a window with `--window-id` and its CG ID, because indexes reorder when focus
changes. Do not combine the selectors.

The screenshot and the tree belong to the same window. Indexes belong to that one observation; they are not
persistent AX identities. The tool cannot detect the replacement or reordering of fully identical anonymous
controls. Standard window buttons exclude decorative glyph descendants. Unsupported AX values are marked unreadable.
The tool cannot lock out concurrent desktop changes, so read the errors and refresh instead of replaying.

### Reading large trees

- `see` reads the whole tree in one `AXUIElementCopyHierarchy` round trip when that private call is available
  (`"bulk": true` in the output). `AX_TOOL_NO_BULK=1` forces the per-attribute walk, and the chrome scope always
  walks.
- `--depth N` takes 1 to 50, or `auto` for 50. A tree deeper than the depth fails by default, and the error
  suggests `--depth auto` and `--truncate`. `--truncate` returns the tree cut at the depth: the result carries
  `truncated: true` and `truncatedAt` (the rows whose children were left out). The token remembers the cut, so `act`
  walks the window the same way and every index stays valid.
- `--query <text>` (with optional `--query-role AXButton`) keeps only the matching elements and their ancestors.
  The whole window is walked, so it works on pages over the 4000-row snapshot limit. The `query` block counts the
  subtrees that the depth left unwalked, so `--truncate` is refused with `--query`.
- `--since previous.json` returns the fresh token, window and screenshot with only the added or changed rows, plus a
  `changes` block with an old-to-new `indexMap`.
- The wrapper accepts native output up to 32 MiB per stream. Over that budget the call fails and never retries an
  action; the action may already have partly run. Use a smaller depth or `--scope chrome`, then refresh.

### Acting

```bash
tools control act \
    --app Calculator \
    --snapshot "$(jq -r .snapshot /tmp/calc.json)" \
    --element 12 \
    --action press
```

- Stale app instances, closed or wrong windows, changed trees, expired tokens and invalid indexes fail before
  dispatch. `ok: true` means the input was dispatched, not that the user's task is done.
- `--refresh` settles and returns the post-action snapshot under `after`, so one call replaces `act` plus a second
  `see`. `--path <png>` names its screenshot and `--no-image` skips it.
- Foreground pointer actions need the exact window already focused. `--background` (click, move, drag, scroll)
  keeps the geometry and hit-ownership checks without needing focus. Keyboard and text input need the intended input
  focused. `--no-activate` (key, type, paste, select, set) delivers to the process without bringing it to the front;
  every result reports `frontmostChanged`.
- `--prepare` focuses, reveals and revalidates the same observed target before element click, key or text input.
- `--coords X,Y` is a global logical screen point by default (a row's `screen` rect, negative display origins
  included), not screenshot pixels (the row's `source` rect). `--frame window` reads the point relative to the
  window's current origin, so it survives a window move; the result echoes `coordinateFrame`, `requestedPoint` and
  `resolvedPoint`. Against a window whose text updates, `--frame window` also needs `--target-key <stableKey>
  --revalidate-scope element`.
- `--revalidate-scope element` with `--target-key <hash>` checks only that the row at `--element` still carries that
  key, so a window with a ticking clock stays actionable instead of refusing with `stale_observation`.
  `--target-ordinal 1/3` names which of several identical rows was meant; it refuses when the count changed.
- `--modifiers cmd,ctrl,alt,shift` holds modifiers on the click events (not on the real keyboard). `--double`
  double-clicks. `--button left|right|middle` picks the button.
- `hover` moves the real pointer onto the target for `--dwell <ms>` (1 to 10000, default 400), reads the tree during
  the hold as `during` with a `revealed` list, then puts the pointer back. `--hold` leaves it there, for a control
  that exists only under the pointer. To put the pointer back later, run `tools control snapshot` before the
  `--hold` act, then `tools control restore --snapshot '<that json>'`.
- 🛑 **The user can take the machine back.** A fling of the pointer into the 4-point square at the top-left corner
  of the main display stops all synthetic input of `ax-tool`. Every post is checked first, and any key or button
  still held is released. The refusal is `user_takeover` and says whether input stopped part way. It is never
  retried: wait until the user moves the pointer away. `GENESIS_CONTROL_ABORT_CORNER=0` turns the check off.
- Under an agent, an act that takes focus or the pointer is refused with `user_active` and
  `dispatchState: "not_started"` while the user typed, clicked or moved the pointer in the last 5 s.
  `--allow-foreground` is for a visible demonstration the user asked for. `GENESIS_CONTROL_FOREGROUND_IDLE=<seconds>`
  sets the quiet time (`0` turns the check off), and `GENESIS_CONTROL_ALLOW_FOREGROUND=1` allows it for a whole run.

### Acting by identifier, without a snapshot

When the app gives an element an `AXIdentifier`, `act --by-identifier <id>` skips the observation step: the same
process walks the app's windows, resolves the identifier and dispatches against that read, so nothing can change in
between. It searches every window, or only `--window-index N`, to `--depth N` (default 20). Zero matches and two
matches are both refusals: the first names the windows it could not read and the SwiftUI identifier propagation
that shadows per-control ids, the second lists every candidate. It cannot be combined with `--snapshot`,
`--element`, `--coords`, `--region`, `--target-key` or `--revalidate-scope`.

```bash
tools control act --app Genesis --by-identifier focus-hud-primary --action press
```

### Prepared retries

A prepared `act` with `--target-key` can recover from a typed stale or focus refusal only when native dispatch is
confirmed `not_started`. The shared runner reuses the original token and fingerprint, allows two retry starts within
1.5 seconds of the first refusal, and reports a `recovery` receipt. Attempts and readback share the original
deadline. It does not repeat completed steps, unknown input, coordinate clicks or Jev decisions. Unstable screenshot
reads have a separate bounded read-only recovery. An observation failure after an action never authorizes repeating
the action.

### Menus and menu buttons

- Pressing an `AXMenuButton` or `AXPopUpButton` opens an in-window menu, and the AX call returns before the menu
  exists. The press waits for the menu and reports `menuOpened`. A swallowed press is retried exactly once, only
  after a fresh read proves no menu is open, and reported as `menuPressRetried`. If no menu is seen even then, the
  action returns `ok: false` with an error saying the outcome is uncertain: inspect instead of repeating.
  `--refresh` waits up to three seconds for the menu rows and reports `after.awaited`.
- A press toggles, so pressing a control whose menu is already open is refused. Close it with
  `--action perform --ax-action AXCancel` on that same control (delegated to the open `AXMenu`). A menu that is
  already closed answers `menuAlreadyClosed`.
- `perform --ax-action AXShowMenu` opens a context menu, which tracks modally inside the AX request. It is performed
  without waiting for the return, and `menuOpened` is decided by looking for the menu: a new window on the menu
  layer (`kCGPopUpMenuWindowLevel`, 101) owned by the app, or an `AXMenu` in its tree. Done synchronously it reported
  `AXShowMenu did not return within 2.0 s (AX -25204)` while the menu was open (measured 2026-10-15 on a SwiftUI
  fixture).
- ⚠️ On a SwiftUI `Button`, `AXShowMenu` opened the context menu of the enclosing view, not the button's own
  `.contextMenu`, and drew it at the hosting view's corner. A right-click on the button opened its own menu.

### Context menus (`see --scope menu`)

`see --scope menu` lists an open context menu instead of the menu bar (`contextMenu: true`). With no context menu
open it lists the menu bar, and `--menu <title>` descends into one top-level menu. Press an item with
`act --snapshot <that snapshot> --element <n> --action press`. A menu snapshot routes to the menu dispatcher and
takes `--action press` or `--action perform` (`--ax-action`, default `AXPress`). Pass `--expect-title <title>` with
the index, because menu indexes shift between observations.

The token remembers it was a context menu. If the menu closed in between (any click or key press of the user closes
it), `act` refuses with `stale_observation` instead of pressing a menu-bar row with the same index. Pressing an item
of an open context menu does not need the app in front. Run the right-click, `see --scope menu` and the press back
to back: an unattended context menu closed within about 5 s in Genesis Markdown (2026-10-15).

### Menu bar status items (`see --scope extras`)

`see --scope extras` reads the app's status items (its `AXExtrasMenuBar`: row 0 is the bar, rows 1 and up the
items). `tools control statusitems [--app A] [--query T]` lists every running app's items with owner, pid and
`element`. `act --snapshot <extras snapshot> --element <n> --action press` opens an item without bringing its app to
the front. AX answers only when the menu closes, so the press reports `opened: "menu"` once the owner's menu window
appears. While the menu is open, `see --scope extras` lists that menu (`statusMenu: true`): press an entry the same
way, or close it with `--action perform --ax-action AXCancel --element 0`. An item keeps its menu in the AX tree after
the menu closed, so a menu counts as open only while the owner has a menu window on screen.

### Right-click

🛑 A right-click never takes the user's focus. A context menu needs neither the app in front nor the real pointer,
so every path delivers it in the background: `act --button right` is always background, `--prepare` skips its focus
and raise step for it, the computer-use `click` with `mouse_button: "right"` is never prepared, and the legacy
`ax-tool click --right` no longer activates the app, raises its window or posts at the global HID tap.

A right-click, on an element or a point, is tried three ways in this order. Each later way runs only when no menu was
seen and no menu of the app is open:

1. `window-event`: an NSEvent-built right mouse down and up addressed to the window.
2. `post-to-pid`: a CGEvent right mouse down and up posted to the pid, with the window number and window-local
   location set.
3. `AXShowMenu` on the element, or on the element under the point (skipped for a double click or a modifier).

After each, the tool waits up to one second for a new menu window of the app or an `AXMenu` in its tree. 🛑
`AXShowMenu` is last because SwiftUI answers it with the menu of an enclosing view: on a Genesis Markdown tab button
it opened the tab bar's one-item menu (Wrap Tabs), and on a fixture `Button` with its own `.contextMenu` inside a
container with another, it opened the container's, while the window event opened the button's own (2026-10-15).
Element targets used to go to `AXShowMenu` first. Measured on 2026-10-13 against a background AppKit probe: no form
made the probe the active app.

The result reports `delivery`, `deliveriesTried`, `menuOpened`, `menuOpenedBy` and `menuItems` (the first five item
titles, so a caller can tell the element's own menu from an enclosing one). `AX_TOOL_CONTEXT_MENU_DELIVERIES` (a
comma list, such as `post-to-pid`) limits the deliveries, for testing one. If no menu is seen, the result is
`ok: false` with `menuOpened: false` and `dispatchState: "dispatched"`, because the events were sent. No path moves the
pointer. If the target still brought itself to the front, the result has `frontmostRestored: true` with a
`focusNote`. An open context menu takes the keyboard until it closes (`menuHoldsKeyboard: true`), so pick an item or
close it with `--action perform --ax-action AXCancel` promptly.

### Drag

`drag` uses the left button and takes `--to X,Y`, `--duration 0.1..5`, `--coords`, `--background` and
`--allow-outside`. `--allow-outside` needs a non-chrome observation; chrome-scoped tokens refuse it, so a toolbar drag
cannot enter omitted page content. With it, the path and `--to` may leave the snapshot window and the window may move
with the drag (a panel dragged by its body): the start keeps every check, each later step checks only that the window
is still on screen and that the user has not taken the pointer, each step's window-local location is measured from
where the window is at that step, and the result reports `windowBoundsAfter`. The computer-use adapter also
extrapolates image-coordinate destinations outside the screenshot when `allow_outside` is set; screenshot dimensions
stay required and the start stays inside the screenshot. Events go to the target app only, so a path over another
app's window delivers nothing to that app.

Background drag and right-click passed the dedicated AppKit fixture; receiving apps must accept background events.
The tool does not activate or raise the app, but an app may change its own key window in response.

### Scroll

`act --action scroll --direction up|down|left|right` scrolls by viewport pages with `--pages 1..20` (default one) or
by an exact distance with `--pixels 1..10000`; the two are exclusive. Both take `--coords` and `--background`. Page
mode uses the viewport of the nearest receiving AX scroll area at the verified point, also when the target is a
child row. If that viewport cannot be established, the command refuses and asks for `--pixels`.

### Select, type and paste

- `select` takes a UTF-16 `--range START,LENGTH` or a unique literal `--text MATCH`. With a literal match,
  `--prefix` and `--suffix` disambiguate its immediate surroundings. `--selection text|cursor_before|cursor_after`
  picks the selected range or the caret. These options belong to `select` only.
- `type` is single-line text of at most 256 UTF-16 code units. Use `paste` for longer text.
- `paste --text PAYLOAD --format text|md|html` pastes at the focused input's current selection. To choose another
  range or caret, run `select`, then `see`, then `paste`. Prefix and suffix do not change the payload, and selection
  flags on `paste` are rejected. `--replace` with `--prepare` proves the whole-field selection (AXSelectedTextRange,
  else cmd+a read back) before cmd+v, so a missed select-all refuses instead of appending; a field that hides its
  selection refuses too.
- Clipboard restore checks ownership and skips a newer copy. It still restores when the only other writer
  re-published our own payload verbatim (a clipboard-history app): our item carries a per-paste nonce and a user copy
  of the same text carries none, so a user copy is never overwritten. The temporary item carries the
  `org.nspasteboard.TransientType` markers, so such apps skip it. The restore waits until the field shows the paste
  landed (up to 3 s), because restoring first made a slow receiver paste the user's original clipboard. It runs on
  every exit path, including a refusal, a readback mismatch and a SIGTERM from the caller's deadline, and every result
  reports `clipboardRestore`. AppKit has no atomic compare-and-swap, so a narrow concurrent-copy race remains. HTML
  paste also carries the raw markup as its plain-text representation, so rendering depends on the receiver.

### Filling a field in the background

`act --action set --value <text> --no-activate` (computer-use: `set_value` without `prepare`, or `fill_form` with
`activate: false`) writes the field's `AXValue` inside the app. The app stays where it is, and nothing touches the
clipboard or posts a key, so the user can keep typing elsewhere. Chromium and Electron apply an accessibility write a
moment after the call returns, so `set` reads the value back for up to one second before it reports a mismatch.
Measured on 2026-10-13 against T3 Code (Electron) in the background: a React `<input>` and a Lexical editor both took
the value, and the page's own state followed it (a list filtered, a Send button turned enabled). A native dropdown
(`AXPopUpButton`) cannot be filled this way, because selecting from it opens its menu: `fill_form` with
`activate: false` stops at one and says to use `activate: true`. An emptied Lexical editor reads back as one newline,
and both `set` and `fill_form` count that as empty.

⚠️ A field that keeps a draft and saves it on blur or Return (T3 Code's settings) shows the written value but does
not save it while its window is in the background: Chromium fires no blur or key event in a page without focus, and
moving the accessibility focus away does not change that. Such a field also copies the saved value back into its
draft when it gains focus, so a background write followed by a prepared key loses the text (seen on 2026-10-13).
Fill it in front instead: `paste --replace --prepare`, then a blur or `key --keys return`.

### Browser chrome and visual regions

- `see --scope chrome` omits web-area descendants, for browser tab strips and toolbars. The token remembers the
  scope and cannot dispatch pointer events inside the omitted web content. Use the default `window` scope for page
  content.
- `see --perception ocr` adds local macOS Vision OCR regions. `--perception-crop x,y,w,h` and
  `--perception-width 400` crop and resize only the OCR input; rectangles map back onto the original screenshot.
  Known AX text inputs are excluded from OCR candidates. No Python, icon model, download or external vision API is
  involved.
- `act --snapshot TOKEN --region v0 --action click` acts on an observed OCR region. Raw `--coords` and drag
  destinations also need screenshot-backed evidence. Native code checks the process and window identity, the exact
  window geometry, the pixel dimensions and the current pixel hash, then consumes the capture before it posts input.
  Visual captures expire after **30 seconds** and permit **one coordinate action** (a double click or a drag is one
  bounded action); ordinary AX tokens keep their 120-second limit. A reused capture fails before another screenshot
  is taken. Used-capture markers live in the private temporary control directory.
- Dispatch and completion stay separate: visual output says `verification: unverified` until the caller checks a
  postcondition. An unchanged AX tree is not enough when canvas pixels changed. The source PNG hash, pixel hash,
  original dimensions, crop and resize transform and logical screen rectangles are returned for inspection.

## Selector command gotchas

- ❗ **When `--title` finds nothing, try `--desc` or `--q`.** Many apps, including Chromium browsers and SwiftUI,
  expose their visible text through `AXDescription` instead of `AXTitle`. This is the most common reason a search
  comes back empty.
- `hittest` is the tie-breaker when a click "works" but the wrong thing responds: it reports the element the system
  really delivers the event to.
- ⚠️ **`type` inserts at the current cursor.** Use `--end` to jump to the end of the field first, or `--clear` to
  replace the whole field. Without either, the text is spliced into whatever was there.
- ⚠️ **`type` prints "typed" only after a readback.** With `--app` alone it reads the app's focused element before
  and after typing. A value that did not change fails (exit 1) and names the focused element and where the keys
  went. An element with no readable value prints `UNVERIFIED` and exits 2 (the JSON carries `ok: false,
  unverified: true`, and `--return` is not sent after unverified text). The computer API's `type_text` reads the
  field back too: `verification.status` is `verified` only when the text was seen in the field, and text that did
  not appear, or could not be read back, returns `ok: false` (the latter as `UNVERIFIED`). Both verify an
  insertion by a new occurrence of the text, so a field that already held it is not a pass. A paste into a field
  whose value cannot be read returns `ok: false` as uncertain.
- An open or save panel runs out of process and can drop typed text (measured 2026-09-28 on Brave's "Load unpacked"
  panel). Put the text on the clipboard and send `hotkey --keys cmd,v`.
- `type` and `hotkey` post to the global keyboard tap, so with `--app` both check the front again when they post and
  stop (exit 1, naming the app that took it) instead of sending the rest of the keys to whatever is in front.
  `--to-pid <pid>` delivers to one process instead of the global tap.
- 🛑 **`type`, `set` and `hotkey` refuse while another app is frontmost** (`src/control/lib/focus-guard.ts`). They
  exit 1 before posting anything, with `refusal: "focus_steal"`, the frontmost app, and the see/act substitute. A
  target that already is frontmost runs as before. `--steal-focus` lifts it for one call; the saved setting
  `focusStealGuard` (`always` by default, `agents` for agent runs only, `off`) is set with
  `tools control config set focusStealGuard <value>`. The same guard covers `control run` steps and the MCP
  `control_run` tool.
- ⚠️ **`hotkey --app` activates the target first and refuses if it cannot become frontmost.** A key combo delivered
  to the wrong app is worse than a failure.
- `scroll --direction` sends wheel events to the window under the point (element centre, `--coords`, or the main
  window's centre) without taking focus; `--foreground` brings the app to the front first. Without `--direction` it
  scrolls the element into view (`AXScrollToVisible`). `--amount` is wheel lines of 40 px (default 3), `--pixels`
  an exact distance (1 to 100000). `--time <s>` spreads the distance over real time at 60 events per second like a
  trackpad flick (`--ease flick|linear`), and `--repeat <n>` with `--pause` (default 0.3 s) and `--alternate` scrolls
  down and up again. To reproduce a scroll bug, give a real `--time` instead of a loop of short scrolls.
- `screenshot --window` fails loud on zero or two or more title matches, `--window-id` takes the exact id `see`
  reported (the only way to reach one of two windows with the same title), and an unscoped call picks the largest
  window. `--crop x,y,w,h` is in pixels of the captured image. `--annotate --all` boxes every element with an id,
  description or title.
- `tools control screenshot --app GenesisTools --path /tmp/x.png` captures the live window with no accessibility
  walk, so it works while the app is busy.
- `tools control window --app <pid> --json` prints `"screenLocked": true` while the screen is locked. Window and
  animation tests fail then.

## Plans

### The plan contract (`run`)

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

The plan decides the mode, not a flag:

- **No `atMs` anywhere**: sequential. Each step runs, with `delayMs` (default 200 ms) between them.
- **Any step has `atMs`**: timeline. Steps fire at their offset from the start, and steps without `atMs` run back to
  back after the previous one.
- **`capture` present**: the whole plan goes to the capture runner, and `steps` is accepted as an alias for its
  `actions`.

Step fields: `do`, `atMs`, `q` (universal search), `id`, `role`, `title`, `desc`, `subrole`, `window`, `value`,
`text`, `path`, `keys`, `action`, `crop`, `delay`, `app` (override). `wait` and `assert` also take `gone`, `for`
(`"enabled"` or `"focused"`), `expect`, `contains`, `timeout` and `interval`. Roles and subroles are fuzzy by default;
`exact: true` forces strict matching. The aliases `ax-set`, `ax-press` and `ax-perform` map to `set`, `press` and
`perform`.

The top-level `ok` is true only when every step succeeded. `failedSteps` carries the count, and `steps[]` carries each
step's result JSON and wall-clock time in ms. `restore: true` saves the mouse and focus before the run and restores
them after. `--dry-run` validates every step and touches no UI. `--stop-on-fail` (or the plan's `stopOnFail: true`)
stops at the first failed step and reports the rest as skipped.

The runner also reads these step fields itself. `saveAs: "<name>"` keeps a step's result. A later string field can
use `{{steps.N.result.<field>}}` (N counts from 0) or `{{saved.<name>.<field>}}`, so "find the id, then press it" is
one plan. An unresolved reference stays verbatim instead of becoming an empty value. `retries` (0 to 10) and
`retryDelayMs` (0 to 60000 ms) repeat a failed read step: `get`, `find`, `attrs`, `actions`, `window`,
`screenshot`, `ocr`, `wait`, `assert`, `apps`, `dump`, `typography` or `hittest`. A mutating step refuses `retries`
above 0, because a retry would act twice.

```bash
tools control run plan.json
tools control run --dry-run --plan '{"app":"Genesis","steps":[{"do":"press","q":"Chat"}]}'
```

`wait` and `assert` also run alone. `wait --gone` passes at once for an element that never existed, and
`assert --gone` passes for one too, so check that the element existed first when that matters.

### Recording a plan instead of writing one

```bash
tools control record-plan start --record all
# ...run commands, or drive the UI by hand...
tools control record-plan stop --out plan.json
tools control record-plan status

# One shot: record 20 seconds of real activity, then emit the plan
tools control record-plan --record activity --duration 20 --out plan.json
```

Modes for `--record`:

- **`commands`**: logs every later `tools control` action command (`press`, `click`, `set`, `type`, `hotkey`,
  `scroll`, `perform`, `screenshot`, `window`, `focus`) from any terminal until stop. Read-only commands (`get`,
  `find`, `attrs`, `preflight`) are not recorded on purpose.
- **`activity`**: records your real clicks, keys and scrolls through a CGEvent tap, and resolves clicks to AX
  elements (id, desc, role) so they replay.
- **`all`**: both, deduplicated. This is the default.

Synthesis joins keystrokes into `type` steps (Return becomes `"return": true`), modifier combos into `hotkey` steps
and wheel bursts into `scroll` steps. Clicks prefer id, then desc, then title, then raw coordinates. Review the plan
before you run it. At stop, `--app <name>` forces the plan-level app instead of the most frequent one, and
`--exclude-foreign` drops commands recorded from other terminals instead of marking them `_foreign`.

`record-plan capture` writes a ScreenCaptureKit capture plan instead (it takes the `capture record` flags):

```bash
tools control record-plan capture \
    --window-ids 4242 \
    --canvas crop \
    --out capture.json
# edit its actions, then:
tools control capture capture.json
```

### Workflows (`workflow run`)

`workflow run` runs a versioned plan (`{version: 1, app, stopOnFail?, steps: [...]}`) inside one pinned app window.
The runner takes its own fresh observation for every step, binds the step to it and verifies the step's
postcondition before the next. It is the CLI door to the runner that the MCP `run_workflow` and
`control_workflow_run` tools use.

```bash
tools control workflow run workflow.json --app "Example App" --values values.json
tools control workflow run --plan '{"version":1,"app":"Example App","steps":[...]}'
cat workflow.json | tools control workflow run -
```

Flags: `--app`, `--window-id`, `--scope window|chrome`, `--simulator [udid]` with `--bundle-id`, `--timeout <ms>`
(default 120000), `--values <file>`, `--continue-on-fail` (the plan's `stopOnFail: false`; never after uncertain
delivery), `--jev`, `--rebind` (implies `--jev`), `--max-steps` (default 20) and `--max-requests` (default 30).
Exact postconditions make no model call.

### Semantic plans (`replay-plan`)

```bash
tools control replay-plan workflow.json --values values.json --rebind --window-id 123
```

A version 1 plan binds each step against a fresh observation, first by an exact unique selector, then (only with
`--rebind`) by Jev. Every step has a required postcondition and `noRetry: true`. Unknown dispatch or readback stops
the run. Repaired selectors stay in the result unless a verified run uses `--save-repairs new-plan.json`; the original
is never overwritten. Shared caps: `--timeout` 120000 ms, `--max-steps` 20, `--max-requests` 30.

```json
{
  "version": 1,
  "app": "Example App",
  "scope": "window",
  "windowTitle": "Profile",
  "steps": [{
    "id": "name",
    "action": "set",
    "selector": {"identifier": "full-name"},
    "intent": "Enter the supplied full name",
    "valueRef": "name",
    "postcondition": {
      "expect": "The supplied name is displayed",
      "exact": {"identifier": "full-name", "valueRef": "name"}
    },
    "noRetry": true
  }]
}
```

Exact values come from a separate local file such as `{"name":"Example Person"}`. Choosers see field descriptions and
redacted inputs, never this values map. Set steps also verify the exact written value before the recorded
postcondition. Missing values are rejected before any observation or action.

`record-plan stop --semantic metadata.json --out workflow.json` attaches the same versioned metadata to a recording
after it checks every recorded action, selector, app and fixed parameter. A key chord cannot change during
attachment, and unsupported side effects such as the legacy `--return` are refused instead of dropped. Inline values
become references in the emitted plan. No observations or screenshots are kept automatically; optional context holds
only caller-supplied role and label pairs.

Plans support `press`, `set`, `click`, `focus`, `key`, `type`, `paste`, `select`, `scroll` and an exposed AX
`perform`. `parameters` carries fixed verb-specific arguments such as `{"keys":"super+a"}`,
`{"direction":"down","pixels":80}` or `{"axAction":"AXShowMenu"}`. Text actions use local `valueRef` values. Exact
postconditions may name `attribute` as `AXValue`, `AXFocused`, `AXSelected`, `AXExpanded` or `AXSelectedText`.
Semantic postconditions need `--jev` or `--rebind`. Unsupported recordings fail explicitly. The legacy `run` path
stays available for old plans and refuses semantic plans instead of ignoring their postconditions.

## Screenshots, annotation and before/after reports

- `draw` works on any capture source (playwright, `screencapture`, this tool), because annotation is pure
  post-processing. Coordinates are natural image pixels. Kinds: `highlight` (rounded-rect outline), `box`,
  `ellipse`, `arrow`, `label`, `blur` (redact), `crop` (applied last) and `grid` (a coordinate finder). The plan is
  `{annotations: [{kind: "highlight", rect: {x,y,w,h}, label: {text: "..."}}], preset?}` or a bare array, inline or
  from a file, and `--annotate <json-or-path>` is required. `--out` (default `<input>-annotated.png`, or the plan's
  `output` field), `--preset review-red|callout-amber|redact` (wins over the plan's preset) and `--json`.
  `--in-place` overwrites the input image and keeps no copy; without it the original is never changed. It cannot be
  combined with `--out`.
- `ocr --app <name>` reads a window (`--window`, `--window-id`), `ocr --image <file>` reads a file, and `--crop`
  limits it to a pixel region.
- `compare-screenshot <a> <b>` exits `0` within `--max-mismatch <pct>` (or with no gate), `1` over it, and `2` for
  unusable inputs such as a size mismatch without `--resize-to-match`. `--threshold` (default 0.1) sets per-pixel
  sensitivity, `--diff-out <png>` writes the diff, `--regions` clusters changed pixels into boxes
  (`--merge-distance` 12, `--min-area` 24), and `--annotate-out <png>` draws the numbered boxes onto B. A pair of
  GenesisTools `--snapshot` shots is checked by their `<shot>.geometry.json` sidecars: another point size is refused,
  the same size at another scale is resampled and reported.
- `compare-tree <before> <after>` diffs the `<shot>.tree.json` view trees of two hub shots taken with
  `--snapshot-tree`. Controls are matched by identifier, else by role path, and reported as moved, resized, added,
  removed or restyled. Text values are never compared. Exit 0 means no layout change, 1 changes, 2 no usable tree.
  `--tolerance <pt>` (default 1).
- Before/after is a report, not a pixel diff: two shots taken at different times show other data. Take both sides
  as GenesisTools.app hub shots (`--hub --snapshot <png> --snapshot-tree`) at the same pinned `--width` and
  `--height`, then run `report`. A worked example is in the skill's
  [native-cli.md](../../plugins/genesis-tools/skills/macos-control/references/native-cli.md#beforeafter-reports).

```bash
tools control draw shot.png --annotate plan.json --out shot-annotated.png
tools control report ~/Projects/app/shots --out ~/Projects/app/report
```

`report` takes a shot list (`{"title"?, "pairs": [{"screen", "before", "after", "fix"?, "note"?}]}`, paths relative
to the file) or a folder of `<stem>-before` and `<stem>-after` images. Per pair it runs the geometry check, the pixel
regions and the view-tree diff when both shots have a tree. Red is a change, amber is data only. It writes
`NN-<screen>-1-before.png` and `NN-<screen>-2-after.png` into `--out`, an `order.txt`, a markdown note (`--note`,
default `<out>/report.md`), and prints the command that opens the pairs side by side in Preview. `--notes <json>`,
`--title`, `--raw` and `--resize-to-match` refine it. Exit 0 means every pair reported, 1 a pair was refused, 2
unusable input.

## Recording

### Plans and units

`tools control capture --help` prints the full capture plan contract (TypeScript types, units, glossary, result
schema and an example). Run `capture preflight [--app <name>]` before you write a plan. The units are the classic
failure:

- `coords` in click and scroll actions are global screen points, origin at the primary display's top-left, negative
  values legal. With `relativeTo` they are point offsets from the window's top-left, resolved when the action fires.
- `region` in crop actions is frame pixels: display points times the captured screen's scale factor.
- `capture.region` is screen points.
- `duration` is seconds. `atMs`, `fromMs` and `toMs` are milliseconds. Plans warn on a duration over 180.

Four image products come out of a run: `frames` (kept full frames), `crops` (labelled tiles per crop window),
`strip` (all tiles stacked in time order) and `strip-review` (the strip at 1600 px or less on its long side; read
that one for review). The run result carries a `warnings[]` array: read it, because "actions fired but only 1 frame
kept" means the motion never reached the pixels. You cannot ask for exactly N frames: duration, frame rate and
threshold set a budget, and the recorder keeps the frames where motion crossed the threshold. `recrop` re-crops a
finished run's frames offline. A `vitrinka` block in the plan publishes the strip, crops or frames.

A plan's `annotate` field (`{annotations, preset?}`, the `draw` plan) or `capture run plan.json --annotate
<json-or-path>` draws that plan onto every kept frame after the recording, so capture and `draw` are one step. The
frames go to `<sessionDir>/annotated/` and are listed in `result.annotated`. Coordinates are frame pixels (the crop
region's space).

### Native recording (the default)

The default backend records with ScreenCaptureKit inside `ax-tool capture` and fires timed input through the native
Computer Use API. Native preflight, focus, crop lookups and action dispatch do not call Peekaboo or AppleScript. URL
scripting, raw osascript and media-key rewrites are rejected before recording starts. Native input needs an explicit
app and an unambiguous window or target. Native `type` is single-line and at most 256 UTF-16 units; `ax-set` takes
longer values. Native scroll `amount` is pixels. A build or start failure stops the run with "No fallback was
attempted"; the backend never changes by itself. The old behaviour stays available only through an explicit
`capture.backend: "peekaboo"`.

```bash
tools control capture targets
tools control capture record \
    --window-ids 4242,4243 \
    --canvas crop \
    --duration 4 \
    --video-out /tmp/demo.mp4
```

`capture record` flags: `--window-ids`, `--include-app <name-or-pid>` (repeatable), `--canvas crop|display`,
`--screen-index`, `--output-size WxH` or `--output-scale <n>`, `--transparent`, `--codec h264|prores4444`,
`--no-indicator`, `--video-out`, `--active-fps` (0.5 to 120; 60 with a video, else 8), `--idle-fps` (0.1 to 5,
default 2), `--threshold` (default 2.5 %) and `--duration` (0.1 to 180 s, default 3).

Isolated windows (`capture.mode: "isolated"`, macOS 14 and later) pin 1 to 16 visible windows by `windowIds` or
`apps`. Each window gets its own desktop-independent stream, so other apps, the desktop and the recording border never
enter the picture. `transparent: true` keeps PNG alpha; a transparent video needs `codec: "prores4444"` and `.mov`.
The red indicator border is on by default and never recorded. This mode excludes the system cursor and cursor
overlays; use region or screen mode when they must show.

Native-only capture plan fields (the `ax-tool capture` flag in brackets):

- `displayId` (`--display-id <id>`): screen mode, record the display with this CGDirectDisplayID (`ax-tool screens`
  prints `displayID`). Wins over `screenIndex`. An unknown id fails with code `display-missing`.
- `followFocus` (`--follow-focus`): screen mode, record the display that holds the frontmost app's focused window,
  else the display under the mouse. Checked every 250 ms; a change switches the stream live. Not with `displayId`.
- `maxLongSide` (`--max-long-side <px>`): the longer side of a kept frame is at most this many pixels; the aspect
  ratio stays. Not in isolated mode.
- `quietMs` (`--quiet-ms <ms>`): calm time before the idle frame rate. Default: eight frames at the active rate.
- `heartbeatSec` (`--heartbeat-sec <s>`): keep a frame (reason `heartbeat`) at least every s seconds while nothing
  changes. 0 is off.
- `maxMb` (`--max-mb <n>`): stop keeping frames after n MB were written. Sampling and motion go on.
- `audio` (`--audio system,mic`): record system audio (`excludesCurrentProcessAudio`) and the microphone (macOS 15
  and later, else code `unsupported`), each as its own AAC track in `videoOut` (system 2 channels, mic 1, 48 kHz).
  Needs `videoOut` or `audioSidecar`; not in isolated mode.
- `micDevice` (`--mic-device <uid>`): an input that `ax-tool audio-devices` lists as `id`; an unknown one fails with
  code `device-missing`. Default: the system input.
- `audioSidecar` (`--audio-sidecar`): also write `audio-system.m4a` and `audio-mic.m4a` next to the frames.
- `cursorTrack` and `cursorShapes`: the pointer as JSON lines for auto zoom, and the system cursor images.

Each frame carries `displayId` and `motionBoxes` (`[x, y, width, height]` in output pixels, at most 8, merged from the
changed 4x4 sample blocks; empty for first, heartbeat and display-switch frames). A recording that ends early still
prints every frame with `endedEarly`: `display-removed` (with `followFocus` the recording moves to the display that now
holds focus instead), `stream-error` or `stopped` (SIGINT or SIGTERM). Errors print `{"ok": false, "error", "code"}`
with code `display-missing`, `no-permission`, `invalid-argument`, `unsupported`, `device-missing` or `failed`. A display
records at its backing pixel size (a 2x display at 2x) unless `outputScale`, `outputSize` or `maxLongSide` limits it.

### Controlling a running recording

`ax-tool capture --control-stdin` (screen, window and region mode) reads one JSON command per stdin line:

- `{"cmd":"switch","displayId":N}` (screen mode without follow-focus; the next frame has reason `display-switch`),
  `{"cmd":"pause"}` (no frames kept, also stops audio), `{"cmd":"resume"}`, `{"cmd":"status"}` and `{"cmd":"stop"}`
  (the same as SIGINT). The end of stdin also stops.
- `{"cmd":"mute","source":"mic"|"system"}` and `unmute` (a muted source writes silence, so the timeline keeps its
  length; the result lists the spans in `mutedSpans`), `{"cmd":"set-mic","deviceId"}`,
  `{"cmd":"set-fps","active","idle"}`, `{"cmd":"set-threshold","percent"}` and `{"cmd":"set-max-long-side","px"}` (0
  removes the cap; only without `videoOut`, the next frame has reason `resize`).

Events go to stderr as JSON lines: `{"event":"frame","index","displayId","timestampMs","file","path","reason"}`,
`{"event":"state","state":"recording"|"paused"}` (status adds frames, capturedFrames, bytesWritten, displayId,
elapsedMs; mute adds `muted`), `{"event":"settings"}` (`activeFps`, `idleFps`, `threshold`, `maxLongSide`, `muted`,
`micDevice`), `{"event":"display-switch","from","to"}` and `{"event":"error","code","message"}`. An unknown display
answers an error and the recording goes on. The result JSON stays on stdout. With `audio`, the result has `tracks`:
`[{source, channels, sampleRate, startMs, durationMs, peakDbfs, mutedSpans, inMovie, file, path}]`, times from the
first video frame. `ax-tool audio-devices` prints `{inputs, outputs}` with `id`, `name`, `channels` and `default`.

### Recording sessions and live recordings

```bash
tools control capture session \
    --target '{"kind":"app","app":"Finder"}' \
    --stop-on-stdin \
    --json
```

`capture session` takes `--target` (`{"kind":"window","windowIds":[n]}`, `{"kind":"app","app":"Finder"}` or
`{"kind":"display","screenIndex":0}`; default the front window), `--exclude-window-ids`, `--fps` (default 60),
`--no-indicator`, `--max-seconds` (1 to 600) and `--output` (default `~/.genesis-tools/control/recordings/`). It is
made of segments: one recorder run stops after 180 s, so a longer recording chains runs, and stop joins them into one
movie.

A window named in `--exclude-window-ids` that still exists but that screen capture does not list within a second fails
the start with code `failed`, and nothing is recorded: the recorder cannot leave out a window it cannot see, and the
movie would show it. A live switch inside one recorder run (`--follow-focus`, or the `ax-tool --control-stdin`
`switch` above) checks it again, for up to a second, and keeps the recording on its display when the check fails; a
restart after the recorded display went away ends that run with `endedEarly: "exclusion-unresolved"`, and the
session pauses with the reason. A session `switch` (below) stops the segment and starts a new one on the new target,
so it runs the start's check: when that fails, the session pauses and nothing records on the old display.

With `--stop-on-stdin` it reads one JSON command per stdin line, and the end of stdin stops and keeps the recording:

- `{"cmd":"pause"}`, `{"cmd":"resume"}`, `{"cmd":"restart"}`, `{"cmd":"stop"}` and `{"cmd":"discard"}`.
- `{"cmd":"switch","target":{...}}` with a target of the same shape as `--target`.

These are not the `ax-tool --control-stdin` commands of the section above: a session switch takes a target, not a
`displayId`. The session reports the events `state`, `elapsed`, `segment`, `done`, `discarded`, `preparing` and
`error`. With `--json` they are JSON lines on stdout; without it they are short human lines on stderr.

While it runs, the session registers as a live recording (kind `control-session`,
`~/.genesis-tools/recordings/live/<id>.json` with a JSON-RPC socket beside it). The socket serves `status`, `pause`,
`resume`, `stop {wait}` (the segment join runs as a job with `progress`), `discard`, `restart`,
`target.switch {target}`, `displays.list`, `displays.switch {displayId}` and `jobs.list`. The stdin JSONL commands go
through the same adapter, so stdin and the socket behave alike. Both files go when the session ends. The menu bar and
`tools meetings record` read the same folder.

### The Peekaboo backend (opt in)

`capture.backend: "peekaboo"` runs the external Peekaboo binary. For agent-driven plans set `noRemote: true` and
`captureEngine: "cg"`: that skips the bridge, which is the flaky part in subprocess contexts. If recording does not
start within 15 s, the runner kills attempt 1, waits 2 s and retries once on the opposite transport. Notes from the
contract:

- SPA links can swallow the first synthetic click when the app is not frontmost; plan a sacrificial click about 1 s
  before the real one, or set `plan.focus`.
- A `url` action defaults to `new-tab` and never clobbers what the user reads. Prefer it over `cmd+l` plus typing,
  because user keybindings shadow shortcuts.
- ⚠️ `peekaboo capture video <mp4> --no-diff` (the offline re-sample path) corrupts colours (frames come out blue,
  average RGB 26,28,32 became 28,26,253). Live-kept frames are fine, so prefer a higher live `activeFps`.
- `countdownSec` prints to stderr; the floating panel does not render when an agent spawns the runner.

## Jev semantic control

Jev is the only AI model `tools control` calls, through direct TypeSafe or Vercel AI Gateway. Ordinary see/act,
selector and plan commands make no AI call. Every Jev command is bounded by a deadline, a request budget and, where
it acts, an action budget. The same commands run as `tools jev control <command>` from the Jev tool, and
`--no-cursor` works there too.

### Read-only decisions

```bash
tools control resolve --app TextEdit --intent "the settings button for this account" --provider typesafe
tools control judge --app TextEdit --expect "the export finished successfully"
tools control judge --app Fixture --expect "counter is one" --exact-id counter --exact-value 1
```

`resolve` and `judge` inspect a window without dispatching. Both take `--provider`, `--window-id`,
`--scope window|chrome` and `--snapshot-file` for a retained full `see` observation. Targets come from observed
AXPress actions or writable text fields, with ancestor context. Disabled and hidden targets and secure fields are
excluded. Unknown or uncertain choices abstain. Resolution returns the snapshot token and the selected element
without running it.

Judging reports verified, refuted or unknown, evidence IDs, probabilities and its semantic or exact basis. A button
label is not completion evidence. Conflicting failure evidence blocks success. Exact ID and value readback does not
call the model. A semantic verdict is a model judgment, not proof of hidden app state. Requests carry window and
candidate labels and redacted observation text; writable input values stay local. The model cannot build action
arguments or bypass the native snapshot freshness and window checks.

### Exact, Jev and host choosers

```bash
tools control choose --app Example --intent "Refresh" --chooser auto
```

`choose` defaults to `--chooser exact` (no AI). `auto` resolves a unique exact label locally, else asks Jev once.
It returns separate coverage, conflict, probability, margin and confidence signals. Uncertain or conflicting choices
return a bounded redacted evidence packet; a host handoff makes no extra AI request. `--host-decision decision.json`
takes `{"packet": <original packet>, "answer": {"packetId": "...", "choice": "c0", "evidence": ["e1"]}}`; changed or
expired observations, invented IDs and extra action fields are rejected. The tool never asks the host for shell code,
coordinates or new payloads.

`compare-choosers --jev --split held-out` runs exact, Jev and auto on the same fixed synthetic cases. Without `--jev`
the comparison is exact-only. Development and held-out cases are reported separately; this small corpus is a smoke
check, not a desktop accuracy benchmark. `--jev --split all --calibrate` (calibration needs both) collects each case
and mode once and replays four
conservative threshold policies locally. The report picks a policy by development labels only (fewest wrong choices,
then most correct outcomes), reports held-out accuracy, abstention and host handoffs, and keeps the default policy on
ties. The sweep makes no extra requests, and live action thresholds do not change. The Jev dashboard's comparison
endpoint takes the same `calibrate: true` with `jev: true, split: "all"`. Missing provider usage or cost is reported
as unknown, not zero. These ten synthetic cases do not prove real-world accuracy, fewer assistant turns or speed
parity.

### Bounded tasks (`assist`)

```bash
tools control assist \
    --app Editor \
    --window-id 42 \
    --goal "Open preferences and enable line numbers" \
    --max-steps 4 \
    --max-requests 10 \
    --provider typesafe
tools control assist --app Fixture --goal "Enable Show line numbers" --exact-id line-numbers --exact-value 1
```

Assist admits observed AXPress actions only. Each attempt uses the current snapshot, then takes a fresh observation in
the same process and window. It stops on abstention, uncertainty, unchanged state, cancellation, deadline or budget
exhaustion. A reobserve decision is allowed once. Failed or partly delivered native actions are never retried. Goal
completion is reported with an explicit exact or semantic basis. `--check-first` judges the postcondition before the
first action, for a goal that may already be met; it is off by default to save one paid evaluation.

Defaults: 8 action attempts (`--max-steps`), 20 model requests (`--max-requests`) and 120 seconds (`--timeout`).
Native calls are capped at 10 seconds each. Ctrl-C stops the model call or the next iteration; an in-flight native call
may return within its cap. First-use native compilation has its own limit (see [How it works](#how-it-works)). Text
entry belongs to `fill`; generated text, shell commands, coordinates and automatic focus changes are not supported.
`--chooser exact|jev|auto` (default `jev`) picks the chooser; exact-only assist also needs `--exact-id` and
`--exact-value` and recovery off, so it cannot fall into semantic judgment.

### Observe fan-out

```bash
tools control observe --app Fixture --goal "Enable Show line numbers"
tools control assist --app Fixture --goal "Enable Show line numbers" --no-fanout
```

`observe` (`observeFanout` in `src/control/lib/decision/observe.ts`) takes one `see` and asks five questions in one
request: which target, whether the goal is already done, whether the view is blocked, whether to wait, and the risk of
acting. Code branches on the answers. The act is always the chosen target's own action, so no answer can pair a
target with an act it cannot take. The default targets are press rows only. A caller may pass `triedHere` (labels of
acts that already led back to this screen); they reach the model as `already_tried_on_this_screen`. `--yes` lets it
recommend high-risk acts.

`assist` uses the fan-out by default and keeps the serial guards: a checkbox or toggle is never dispatched twice while
completion stays unverified (the double-toggle guard), a refusal goes through the bounded `RecoveryController`, and
an action that changes nothing observable ends with a final `judgeOutcome` instead of a repeat. `--no-fanout`
restores the older serial chooser (`chooseCandidate` then a separate judge). A refuted exact readback returns
`{ status: "blocked", reason: "exact_readback_refuted" }`.

### Bounded recovery

```bash
tools control assist --app Example --goal "Enable line numbers" --recovery bounded --max-recoveries 2
```

Recovery uses native delivery metadata. A stale snapshot or a missing target may be reobserved and decided again. An
unknown or partial mutation, a changed app or window, or a permission or authentication barrier stops. Normal request
and action budgets cover recovery too. A successful no-op is never repeated.

`--remedies remedies.json` admits explicit local dismiss and back controls only:
`[{"id":"close-help","kind":"dismiss","identifier":"help-close","label":"Close help","role":"AXButton","description":"Close the help overlay"}]`.
The identifier, role and label must uniquely match fresh state. There is no default generic Cancel or Back click. The
result keeps the refusal, the evidence, the supplied remedy set, the model choice and the recovery action result.

### Structured form filling (`fill`)

```bash
tools control fill --app Fixture --window-id 42 --data fields.json --provider typesafe
```

`fill` takes an object of 1 to 20 supplied string values, such as `{"Full name":"Alice Example","City":"Springfield"}`.
It maps keys to observed writable text fields, keeps the values out of model requests, sets each exact value,
reobserves after each attempt and verifies the final readback. Bindings must be unique and one-to-one. Secure inputs,
unsupported dropdowns, masked readback and ambiguous fields stop the run. It never presses Submit or types generated
text. `--max-fields` (default 20), `--max-requests` (default 20), `--timeout` and Ctrl-C bound it. Partial progress is
returned on failure.

### Semantic waits (`await`)

```bash
tools control await \
    --app Editor \
    --window-id 42 \
    --condition "A saved confirmation is displayed" \
    --timeout 30000 \
    --max-requests 12 \
    --provider typesafe
tools control await --app Editor --condition "Save finished" --exact-id status --exact-value Saved --max-requests 0
tools control wait-replay ready --chooser oracle
```

`await` pins the process launch and window and batches loading, ready, blocked, failed and evidence questions.
Readiness needs an observable condition and admitted evidence; it does not prove hidden server or file state. Failure
and human-input blockers take precedence. A loading classification is advisory; terminal states need an admitted
witness. Uncertain evidence stays uncertain. `--evidence-id`, `--evidence-label` and `--evidence-role` limit the
evidence to one container, so changing unrelated panels are ignored.

AXObserver notifications wake the reader where supported, with a bounded one-second snapshot fallback and a short
event debounce. Repeated observations create no PNG files. Geometry, indexes, capture metadata and other non-semantic
fields cause no new model request. A monotonic deadline (default 30000 ms), cancellation and the request budget
(default 12) bound every run. A stable spinner produces "no observed progress", not a claim that the app is dead.

`--exact-id` with `--exact-value` and `--max-requests 0` checks readiness locally with no AI call. The Computer Use
API offers the same check as
`computer.await_condition({app,condition:"Save finished",exact:{identifier:"status",value:"Saved"},max_requests:0})`.
`wait-replay` (cases `ready`, `blocked`, `failed`, `unchanged`) and the Jev dashboard's Semantic waits card run the
same wait core with a virtual event source. The oracle checks the plumbing without a model. No desktop action is
dispatched by a replay.

### Replays

```bash
tools control replay --list
tools control replay context --chooser jev --provider typesafe
tools control replay completed --chooser mock
tools control resilience-replay stale
```

`replay` takes a built-in case ID (such as `context`, `disabled`, `missing`, `completed` or `contradiction`) or a
labelled JSON fixture. It is always decision-only, with zero native actions. The fixture oracle checks the pipeline
with known labels; it is not a model accuracy benchmark. The Jev dashboard's Control tab compares exact-label
matching, the oracle and Jev. Missing provider cost is shown as unknown, never as free. `resilience-replay` replays
the recovery fixtures (`stale`, `unknown`, `permission`, `cap`) and workflow fixtures (`reordered`, `renamed`,
`ambiguous`) with the free oracle, or with Jev under `--jev`.

### Sequences in a persistent session

```bash
tools control --provider typesafe sequence "Click all the browser tabs." \
    --app com.brave.Browser \
    --role AXRadioButton \
    --within AXTabGroup \
    --within-index 0 \
    --window-ids 4242 \
    --scope chrome \
    --verify selected \
    --interval 120 \
    --restore-selected
```

`sequence` applies one intent to a bounded observed target set. It keeps native AX references and the Jev client
loaded, so each action does not restart the helper, take a screenshot or hash an unrelated transcript. Targets can be
buttons, tabs, rows and other AXPress controls. Get window IDs and root order with `see --scope chrome`, and choose a
root index only from that observation. `--focus` focuses each window before binding. `--restore-selected` restores
the target that was selected at observation time. A transient find bar can replace the browser's accessible root;
dismiss it through its observed close control first. No browser scripting API or AppleScript is used.

The model answers a typed target-set question from native control descriptions, scope and labels; it does not produce
action arguments. Matching uses the 0.8 target-selection probability floor, and completion is an exact native readback
of the `--verify` attribute (`selected`, `expanded` or `value`). The native helper checks process launch, window
identity, retained target membership, enabled state and AXPress support before every dispatch. Replaced parent
containers can be rebound only when they still contain the retained target. Missing targets and ambiguous scope stop.
Each batch keeps successful and failed step results; no uncertain mutation is retried. Sessions have a 120-second
lifetime, a 200-action cap and bounded IPC timeouts. Root and window IDs are observation data, not saved authorization.
Two Brave windows with identical geometry are told apart by their native AX window IDs, with strict frame matching as
the fallback when that OS capability is missing.

Live measurement on 2026-09-18: Jev plus native AXPress activated and read back all 74 tabs across two Brave windows
in 10.24 seconds, then restored the selections present at the start. This is a small warm desktop measurement; it
excludes development and cold native compilation.

### Visual choice (`visual`)

```bash
tools control visual --app Example --window-id 42 --intent "Paint" --chooser auto
```

`visual` captures and chooses only. `--click` dispatches one click on the chosen OCR region, and `--background` asks
for window-addressed delivery. `--chooser exact` is the default and makes no AI call. Jev gets observed OCR labels and
rectangles and can return only a region ID, never coordinates or action arguments. `--crop` and `--width` shape the
OCR input.

## iOS Simulator (`sim`)

The same observe, decide, act and readback contract runs against a booted iOS Simulator. `SimulatorControlDriver`
implements the same `ControlDriver` interface as the macOS driver and produces the same `Observation`, so the
admission gate, Jev's classification, the freshness rules and the readback are shared.

```bash
tools control sim devices                                    # booted simulators, with udids
tools control sim launch --bundle-id com.apple.mobilecal     # launch, or bring to the front
tools control sim see --bundle-id com.apple.mobilecal --out screen.json
tools control sim act --snapshot-file screen.json --element 10 --action press
tools control sim act --snapshot-file screen.json --element 12 --action type --text "Standup"
tools control sim act --snapshot-file screen.json --element 19 --action scroll --direction down --pages 1
tools control sim screenshot --path screen.png
```

`--simulator [udid]` (with `--bundle-id`) also reaches `resolve`, `judge`, `choose`, `observe`, `assist`, `fill`,
`await`, `visual` and `workflow run` (not `sequence`):

```bash
tools control assist --simulator --bundle-id com.apple.mobilecal --goal "create an event titled Standup"
tools control resolve --simulator --bundle-id com.apple.mobilecal --intent "the button that adds an event"
```

- **It needs `idb`.** Every verb runs the `idb` client, which drives `idb_companion`. `brew install facebook/fb/idb`
  installs both and needs a full Xcode; with a companion already installed, `pip3 install fb-idb` adds the client.
  The macOS Accessibility API cannot see inside the simulator's rendered surface; the measurement is in
  [docs/benchmarks-simulator.md](../../docs/benchmarks-simulator.md).
- **How a screen is read.** `idb ui describe-all` returns only the elements an app publishes at the top of its
  accessibility hierarchy: 5 rows and no Add button for iOS Calendar's day view. The leaves come from a bounded grid of
  `describe-point` hit tests, which returned 32 elements on the same screen, `add-plus-button` included.
  `--probe-step` (default 40 points), `--max-points` (default 400) and `--no-probe` control that sweep. A sweep cut
  short by its budget reports `probe.truncated: true` and is never presented as a complete screen.
- **Freshness.** The macOS guarantee comes from a tree digest inside `ax-tool`. The simulator driver enforces its own
  equivalent: a hit test at the exact point about to be tapped. If the element there is not the one that was decided
  on, the act is refused as `not_started`. The CLI also re-resolves the chosen element in a fresh read before it
  dispatches, so a decision made against a screen that has since changed is discarded:

```
The chosen element (id:add-plus-button) is no longer on screen.
The screen moved while the decision was being made; observe again.
```

Supported actions are `press`, `click`, `focus`, `type`, `key` and `scroll`. `set`, `paste`, `select` and `perform`
are refused by name instead of approximated.

## Cursors

### The animated action cursor

Mutations show the bundled MIT-licensed Cua Default 2.0.0 vector cursor: cyan fill, white outline, soft glow, a gentle
float, animated action marks and a fading label beside it. Movement glides between resolved targets, and drag feedback
follows the delivered gesture points. It covers snapshot press, click, move, drag, set, perform, focus, scroll, type,
key, select and paste, named software cursors, Jev fill and assist, and the legacy targeted mutations and window
actions. Targetless typing and hotkeys animate at the last known cursor location. Read-only commands stay quiet.

The label says what, why and who, on up to four lines:

1. The action and its target (`Right-click · Finder › "Sidebar" row`: the element's role and title, never its value).
2. What the act writes, in a monospaced face: the text of a `set`, `paste` or `type` (`"~/Projects/app/notes.txt"`,
   cut to 64 characters, a line break shown as `⏎`), `(empty: clears the field)` for an empty `set`, or the keys of a
   `key` act (`keys cmd+a`). A secure text field (`AXSecureTextField` as role or subrole) shows bullets and a count
   instead (`••••••• (7 characters, hidden)`), because the label is on screen and in every recording.
3. The caller's note: `--note "<text>"` on any command, or `note` in a computer-use call.
4. The driving session with foreground or background and AX or pixel context (`Claude · 1b4001ba · background · AX`).
   It comes from the agent host's id (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, `GROK_SESSION_ID`,
   `COPILOT_AGENT_SESSION_ID`), plus `GENESIS_AGENT_NAME` when set. Without a host it names the nearest ancestor
   process that is not a shell or a runtime. `GENESIS_CONTROL_CURSOR_NOTE` and `GENESIS_CONTROL_CURSOR_SESSION` set
   the note and the session directly.

Each part is cut to one short line, and the label flips to the other side near a screen edge. Increase Contrast makes
it opaque with a white border. Clicks are marked at the hotspot when the glide arrives: one cyan ring for a click, two
staggered rings for a double click, and an amber filled ring with a small menu glyph (plus an amber label edge and a
square dot) for a right-click or an `AXShowMenu`. The marks are one-shot animations whose layers are removed after, so
an idle overlay draws nothing new.

The overlay also shows for `--no-activate`, and it never takes the focus: the helper runs with the `.prohibited`
activation policy. Measured on 2026-10-13 with an NSWorkspace activation log over a background `set` into T3 Code:
`.accessory` made the helper active twice per cold start (about 40 ms each, long enough for a typed key to land in
it), `.prohibited` made it active zero times, and the label still drew. If the helper is ever activated anyway, it
hands the front straight back. The click-through overlay never moves the physical pointer or activates a target app.
It is best-effort feedback, not proof of success. Core Animation drives motion without an idle timer. The helper fades
and exits after 20 seconds without actions, with a ten-minute absolute lifetime; the next action starts it again.

Feedback waits up to 1.5 seconds for an event-specific receipt after the helper submits its layers, finishes the glide
and gets two display callbacks. Set `GENESIS_CONTROL_CURSOR_WAIT=required` for demonstrations: missing geometry,
disabled feedback or a missing receipt then stops input. Ordinary mode reports a feedback failure and stays best
effort. Drag waits before mouse-down, then streams samples. Targets are revalidated after the wait; feedback never
overrides a stale-state refusal.

```bash
tools control act ... --no-cursor
tools control cursor hide
GENESIS_CONTROL_CURSOR=off tools control ...
GENESIS_CONTROL_CURSOR_MOTION=off tools control ...
```

Reduced Motion follows the macOS accessibility setting; `GENESIS_CONTROL_CURSOR_MOTION=off` forces still artwork. The
artwork and the Inter font are bundled assets with no runtime downloads. Provenance, licenses and the offline
regeneration script are in `native/ax-tool/CursorAssets`. `cursorOverlay off` in `config` turns the overlay off as a
saved default.

### Named software cursors

`cursor move --app APP --snapshot TOKEN --coords X,Y --name NAME` moves a named software cursor through a
process-targeted mouse-move event. It saves its own coordinates and does not move the hardware pointer.
`cursor show --name NAME` reads that position, and `cursor click --name NAME --snapshot FRESH_TOKEN` clicks it
(`--button`, `--double`). Fresh tokens must match the saved app launch and window. Stale tokens fail natively, and
failed moves do not overwrite the cursor state. The default name is `default`.

```bash
tools control see --app com.brave.Browser --window-id 4242 --scope chrome > /tmp/brave-state.json
tools control cursor move \
    --app com.brave.Browser \
    --name brave \
    --snapshot "$(jq -r .snapshot /tmp/brave-state.json)" \
    --coords 640,90
# Refresh after the move, before the click
tools control see --app com.brave.Browser --window-id 4242 --scope chrome > /tmp/brave-next.json
tools control cursor click --name brave --snapshot "$(jq -r .snapshot /tmp/brave-next.json)"
```

`bun src/control/scripts/brave-tabs.ts --window-id 4242 --proof /tmp/brave-proof.json` checks every visible browser
tab through the real CLI, compares hardware-pointer positions and restores the initial tab. It does not click page
controls or submit forms. Hidden tabs and a changed tab inventory fail instead of reporting partial success.

## How it works

- **Native backend.** The work happens in `ax-tool`, a Swift binary in `native/ax-tool`
  (`native/ax-tool/.build/release/ax-tool`), with macOS APIs only: Accessibility, CoreGraphics, ScreenCaptureKit and
  local Vision OCR. No Codex, Sky or Peekaboo is involved unless a capture plan opts into Peekaboo. It needs only Bun,
  a Swift toolchain (Xcode or a swift.org toolchain) and the macOS grants, because the CLI runs `swift build` itself
  on first use. The CLI rebuilds the
  binary when its sources change; `tools control build` or `tools control prepare` does it ahead of time. A cold build
  took 68 s on a fresh Mac, and a build is cut off after 5 minutes. Direct native callers run
  `swift build --package-path native/ax-tool -c release` after source changes.
- **One core, several doors.** `tools control`, `tools macos control`, `tools jev control` and `tools computer-use`
  share the same control core. `control run` executes a declarative plan; `computer-use run` executes TypeScript.
- **Grants belong to GenesisTools.app** (`com.genesiscz.genesistools`), not to the terminal or a helper binary.
  `tools control` re-enters through the app launcher for every native spawn: `ax-tool` (Accessibility, Screen
  Recording), `peekaboo` in its local runtime, and `osascript` (Automation). Grant each pane once and every terminal,
  editor and agent host shares it. Running the binary directly can have a different responsible process.
- **It changes the apps it reads.** ⚠️ `tools control <anything> --app X` writes `AXManualAccessibility = true` into
  X, because Chromium and Electron build no AX tree until an assistive client asks. Nothing clears it; only a relaunch
  of X does. `AXEnhancedUserInterface` is never set (it changes AppKit layout), so when `audit` finds it on, another
  client set it.
- **Data on disk:**
  - `~/.genesis-tools/control/record/`: the `record-plan` session (`session.json`) and its `commands.jsonl` and
    `activity.jsonl` logs.
  - `~/.genesis-tools/control/cursors/<name>.json`: named software cursors.
  - `~/.genesis-tools/control/recordings/`: `capture session` movies.
  - `~/.genesis-tools/recordings/live/<id>.json` and `<id>.sock`: running live recordings, removed at the end.
  - `~/.genesis-tools/jev/config.json`: saved `config` settings and the Jev provider credential (moved into the
    GenesisTools vault when it is saved as plain text).
  - `see` screenshots go to a unique temporary PNG unless you pass `--path`. `capture clickmap` writes
    `$TMPDIR/clickmap-<ts>.png` by default.
- **What costs money.** Only Jev calls: `resolve`, `judge` without `--exact-id` and `--exact-value`,
  `choose --chooser jev|auto`, `observe`, `assist`,
  `fill`, `await` without `--max-requests 0`, `sequence`, `visual --chooser jev|auto`, and the replays with
  `--chooser jev` or `--jev`. Each has a request cap. Missing provider cost is reported as unknown, never as free.

## Configuration

`tools control config` reads and writes the saved Jev and control defaults. An explicit flag always wins, then the
saved value, then the built-in default. Several keys belong to `tools jev listen` and share this file.

```bash
tools control config show
tools control config set focusStealGuard agents
tools control config unset focusStealGuard
```

| Key | Default | What it sets |
|---|---|---|
| `provider` | `typesafe` | Evaluation provider for every paid Jev call (`vercel` or `typesafe`). |
| `focusStealGuard` | `always` | When `type`, `set`, `hotkey` refuse while another app is in front (`always`, `agents`, `off`). |
| `cursorOverlay` | `on` | Draw the cursor overlay where an act landed. |
| `scope` | `auto` | listen: AX scope (`auto`, `window`, `chrome`). |
| `menus` | `on` | listen: offer the app's menu bar items. |
| `stt` | `deepgram` | listen: speech-to-text provider. |
| `language` | `auto` | listen: STT languages, comma separated. |
| `gate` | `0.8` | listen: admission probability. |
| `confirmRisk` | `off` | Ask for a spoken confirmation at or above this risk (`off`, `medium`, `high`). |
| `narrowAt` | `25` | How many candidates make a screen ambiguous enough to offer narrowing rows. |
| `speak` | `off` | Say the chosen label aloud: `off`, `decisions`, `all`. |
| `historyDepth` | `5` | How many past asks travel with each choice. |
| `browser.port` | `9222` | CDP port for the browser surface. |
| `maxSeconds` | `60` | listen: session budget in seconds. |

**Jev credentials.** The lookup order is: the provider's variable (`TYPESAFE_API_KEY` for `typesafe`,
`AI_GATEWAY_API_KEY` for `vercel`), then the key saved by `tools jev login --provider <name>`, then (for `vercel`
only) `VERCEL_OIDC_TOKEN`.

**Environment variables:**

- `GENESIS_CONTROL_CURSOR=off`: no cursor overlay. `GENESIS_CONTROL_CURSOR_MOTION=off`: still artwork.
- `GENESIS_CONTROL_CURSOR_WAIT=required`: stop input when cursor feedback is missing.
- `GENESIS_CONTROL_CURSOR_NOTE`, `GENESIS_CONTROL_CURSOR_SESSION`, `GENESIS_AGENT_NAME`: the cursor label's note and
  session.
- `GENESIS_CONTROL_ALLOW_FOREGROUND=1`: allow focus and pointer acts under an agent for a whole run.
- `GENESIS_CONTROL_FOREGROUND_IDLE=<seconds>`: the quiet time before such acts are allowed (default 5, `0` is off).
- `GENESIS_CONTROL_ABORT_CORNER=0`: turn off the user takeover corner (see [Acting](#acting)).
- `AX_TOOL_NO_BULK=1`: force the per-attribute tree walk.
- `AX_TOOL_CONTEXT_MENU_DELIVERIES=<list>`: limit the right-click deliveries, for testing.
- `GENESIS_TOOLS_NO_APP=1`: turn the app launcher off (see Troubleshooting).

## For agents

- **MCP.** The genesis-tools MCP server (capability `control`) serves `control_workflow_run` (the validated see/act
  workflow, the same runner as `control workflow run`, `stopOnFail` default true), `control_run` (a `control run`
  plan object inline, with per-step `ms`, `failedSteps` and `stoppedAtStep`), and the read-only `control_find` and
  `control_get` (`src/control/mcp/genesis-tools.ts`). Its native calls are async, so a resident server is not blocked;
  the workflow tool makes no model call.
- **Computer Use API.** `tools computer-use mcp` (or `tools control mcp`) exposes the native API as stdio tools, and
  `--repl` preloads `computer` in the persistent repository REPL. `tools computer-use run --file task.ts` runs one
  script. App and window inventory, menu refs, state and diffs, paging, input, sequences and OCR share the same
  backend. Run `tools computer-use prepare` once before latency-sensitive work. See
  [the Computer Use guide](../computer-use/README.md).
- **Persistent native session in the REPL.** Import `NativeControlSession` from
  `src/control/lib/decision/native-session.ts` inside `tools node-repl` and keep the instance across calls:

```ts
const { NativeControlSession } = await import("/absolute/path/to/GenesisTools/src/control/lib/decision/native-session.ts");
const control = new NativeControlSession({ app: "com.brave.Browser", provider: "typesafe" });
const view = await control.observe({ role: "AXRadioButton", rootRole: "AXTabGroup", rootIndex: 0,
    scope: "chrome", windowId: currentWindowId });
const plan = await control.chooseAll("Click all the browser tabs.");
await control.batch({ steps: plan.targets.map(target => ({
    target, verifyAttribute: "AXSelected", verifyValue: true,
})), intervalMs: 120 });
control.close();
```

  Put the absolute path of your checkout in the import. The repository's Bun-based REPL supports TypeScript imports; a
  Node REPL of another host may take only compiled JavaScript. The measured REPL setup took 178 ms, and a later call
  that reused its bindings finished Jev plus two native presses and the restore in 1.04 seconds. Keep sessions short,
  and create a fresh one after expiry or cancellation.
- **The plugin skill.** `macos-control` ([SKILL.md](../../plugins/genesis-tools/skills/macos-control/SKILL.md)) wraps
  this tool with the discovery-first workflow, the "do not take the user's focus" rules and the frame-by-frame review
  loop for recordings.
- **From a worktree**, `tools` on PATH may run the main checkout. Run `./tools control ...` or
  `bun src/control/index.ts ...` there.
- **Output.** `see` and `act` always print compact JSON and take no `--pretty`; pipe them to `jq` to indent. The
  selector and discovery commands take `--json` (raw JSON) and `--pretty` (indented; compact is the default), and
  `dump` and `typography` take `--pretty` only. `doctor`, `audit` and the `sim` commands take `--format json` or
  `--json`.
- **Exit codes.** `doctor` and `permissions request` exit 1 while a grant is missing. `type` exits 1 when the value did
  not change and 2 when it could not verify. `compare-screenshot`, `compare-tree` and `report` use 0 (pass), 1
  (over the gate, changes, or a refused pair) and 2 (unusable input).

## Troubleshooting

- **`"reason": "accessibility-not-granted"` or `"screen-recording-not-granted"`.** The error names the app macOS holds
  responsible ("Terminal (com.apple.Terminal)", or GenesisTools.app when the launcher is in front) and the pane to turn
  it on in. Both carry `refusal: "permission"`, the `responsible*` fields and `viaGenesisApp`, and both warn when the
  responsible binary sits in a versioned folder that the next update replaces. Screen Recording errors have the same
  shape on `see`, `act`, `screenshot`, `ocr --app` and `capture`. Fix it with `tools control permissions request`: it
  asks macOS through the same launcher route (`AXIsProcessTrustedWithOptions`, `CGRequestScreenCaptureAccess`), opens
  each pane and checks once a second for up to 120 s per grant. Ctrl-C stops it. macOS never asks again after a
  recorded denial, so the command prints the `tccutil reset` line instead. Screen Recording reaches the host app after
  a restart. `tools macos permissions open --pane accessibility` opens a pane by hand. Only `permissions request`
  prompts: `doctor` and `audit` stay read-only.
- **`no running app matches '<name>'`.** A typo in `--app`, reported before any grant is checked. Run
  `tools control apps`. A missing grant is never reported as `no windows for <app>`: that message means the query
  succeeded and returned no windows. An app that does not answer the AX query at all reports
  `accessibility query failed ... kAXErrorCannotComplete`.
- **`doctor` exits 0 with a warning.** The launcher is off but the host app holds every grant. That works; the warning
  proposes building GenesisTools.app (with Xcode install steps on a Mac that has only the Command Line Tools).
- **Grants vanish after a runtime upgrade.** With the launcher off (`GENESIS_TOOLS_NO_APP=1`, or
  `tools macos permissions disable`), grants follow whatever process launched `tools`, and a new `bun` binary silently
  revokes them because the grant is per binary. `doctor` names that process.
- **Two things stay outside GenesisTools.app, and `audit` says so.** The Peekaboo bridge transport (the default when
  `capture.backend: "peekaboo"` runs without `noRemote`) is the Peekaboo.app daemon `boo.peekaboo.mac` with its own
  grants; set `capture.noRemote: true` to stay on the local runtime. A `darwinkit serve` process belongs to other tools
  (calendar, reminders, mail); `tools control` does not use DarwinKit.
- **`refusal: "focus_steal"`.** `type`, `set` or `hotkey` saw another app in front. Use the see/act substitute it
  names, or `--steal-focus` for a demonstration.
- **`user_active`.** You worked in the last 5 s and an agent's act needed focus or the pointer. Nothing was sent. Take
  the background path the error names, or pass `--allow-foreground` for a demonstration.
- **`stale_observation`.** The window changed after `see`. Run `see` again. For a window with ticking text, act with
  `--target-key` and `--revalidate-scope element`.
- **A tree deeper than `--depth`.** Use `--depth auto`, `--truncate` or `--query`.
- **An empty `find`.** Try `--desc` or `--q`, and read the match count: zero matches can exit 0. Use `assert` when the
  absence must fail.

## Validation

```bash
bun run test src/control
swift test --package-path native/ax-tool
bun src/control/scripts/live-smoke.ts
bun plugins/genesis-tools/skills/macos-control/scripts/check-help.ts --repo .
```

The live smoke opens a dedicated two-window test app and ends only that app. It needs desktop access; the ordinary
tests do not drive personal apps. Add `--peekaboo` to the help check to validate the optional recording provider.
`live-smoke.ts` modes:

- `--background-only --benchmark`: the repeatable native CPU and call-count benchmark. It spends no AI requests and
  verifies every fixture write.
- `--background-only --semantic`: the real TypeSafe provider against a temporary AppKit fixture. It needs
  `TYPESAFE_API_KEY`, Accessibility and Screen Recording, makes paid requests, and ends only its own fixture PID.
- `--task-benchmark`: complete stepwise and compound public-API tasks on a disposable fixture, with explicit TypeSafe
  Jev requests and exact final-state checks. It alternates order and keeps the first pair apart. `--host-paced` runs a
  single pair with real stdin host dispatch boundaries, wait time included. It measures the given task and
  orchestration; it does not call another computer-use provider or prove speed parity.
- `--cursor-proof`: records five seconds of native press, set and press feedback on a disposable fixture. It is
  separate from `--background-only --verify-pointer`, which checks pointer and foreground invariants without the
  recording's foreground text entry.
- `--background-only --visual --visual-jev`: an isolated fixture that checks the pixel-only change refusal,
  cross-process one-use admission, crop and resize geometry, known-input exclusion and a real Jev-guided OCR click.
  `--visual-jev` enables that paid call.

## Related

- [computer-use](../computer-use/README.md): the Computer Use API, MCP and REPL on the same backend.
- [jev](../jev/README.md): the Jev evaluator, `tools jev control`, `tools jev login` and the dashboard.
- [macos](../macos/README.md): `tools macos control`, `tools macos permissions` and the GenesisTools.app build.
- [recorder](../recorder/README.md): the screen recorder and its editor.
- [meetings](../meetings/README.md): `tools meetings record` reads the same live recordings folder.
- [node-repl](../node-repl/README.md): the persistent REPL for `NativeControlSession` and `computer`.
- [ax-tool](../../native/ax-tool/README.md): the native binary behind every command.
