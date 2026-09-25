# Native CLI contracts

Prefer the standalone TypeScript API for multi-step tasks. The CLI remains useful for one
inspection/action and diagnosis. From a worktree use `bun src/control/index.ts` so PATH does
not silently select an older checkout. Run the exact subcommand's `--help` before new flags.

## Discovery and legacy selectors

```bash
tools control apps
tools control window --app APP
tools control preflight --app APP
tools control find --app APP --text "visible label"
tools control find --app APP --role AXRadioButton --desc "tab title"
tools control attrs --app APP --id OBSERVED_ID
tools control actions --app APP --id OBSERVED_ID
tools control dump --app APP
tools control hittest --at X,Y
```

`find` with zero matches can exit zero: inspect its count, or use `assert`. Browser labels
often live in AXDescription; tabs are AXRadioButton, bookmarks AXButton. Role matching on
legacy selectors can be fuzzy; filters can select the first match. Do not use first-match
selectors for ambiguous automation. `dump`/`typography` are app-wide; they do not accept a
window selector. `hittest` takes a point, not `--app`.

Legacy `type`, `set` and `hotkey` may activate the app and use keyboard events. Legacy `set`
can retry its clear/type path. Prefer validated `act` or the standalone API for no-repeat
guarantees. AXPress itself need not foreground an app, but an app can activate itself in
response. Read-only inspection does not prove focus or authorize a hidden mutation.

## Snapshot actions

```bash
tools control see --app APP --window-id OBSERVED_WINDOW --no-image > /tmp/before.json
tools control act --app APP --snapshot "$(jq -r .snapshot /tmp/before.json)" \
  --element OBSERVED_INDEX --action press --refresh > /tmp/after.json
```

Read the current output, choose the observed index, and check exit/status. `after` contains
the refreshed tree/token. If readback fails after dispatch, inspect once to establish what
happened; do not repeat the input. The API performs these checks internally and owns refs.

`act --by-identifier AX_IDENTIFIER` replaces the snapshot entirely: one process observes the app
and dispatches against that same read, so no `see` runs first and no token exists to go stale. It
searches every window of the app, or only `--window-index N`, to `--depth N` (default 20). It
refuses when the identifier matches zero elements (naming the windows it could not read, and the
SwiftUI identifier propagation that shadows per-control ids) or more than one (listing every
candidate). It cannot be combined with `--snapshot`, `--element`, `--coords`, `--region`,
`--target-key` or `--revalidate-scope`; the identifier is both the selector and the identity.

```bash
tools control act --app APP --by-identifier focus-hud-primary --action press
```

| Native action | Extra arguments | Focus |
| --- | --- | --- |
| `get` | none | Read only |
| `press` | exposed AXPress | Native AX; no required foreground |
| `perform` | `--ax-action` from observed action list | Depends on the exposed action |
| `set` | `--value` | Exact AXValue/native popup selection; no keyboard fallback |
| `focus` | selected element/window | Explicit activation |
| `click` | `--button`, `--double`, `--modifiers cmd,alt,shift,ctrl`, `--background`, `--coords` | Foreground unless explicitly background |
| `move`, `drag`, `scroll` | Fresh geometry; see help for direction/destination | Window-addressed; no hardware-pointer assumption |
| `select` | unique `--text`, context, range or selection mode | AX selection must actually be settable; preparation may be needed |
| `paste` | `--text`, `--format`; `--replace --prepare` for replacement | Focused field, clipboard restoration, exact replacement readback |
| `type`, `key` | `--text` or `--keys` | Correct app/window/input must be focused |

`--modifiers` rides on the click events only (option-click, cmd-click); the real keyboard state
is untouched, so an app must read the flags from its CURRENT EVENT (`NSApp.currentEvent`), not
from `NSEvent.modifierFlags`. A web view sees them as `metaKey`/`altKey`.

A background click (`--background`) posts to the process and needs no focus. Rules learned on a
SwiftUI app (the GenesisTools hub, 2026-09-24):
- SwiftUI can hit-test a title-bar accessory or hosting container to the CONTAINER, not the
  control. The verifier accepts such a coarse hit only when the hit is an ancestor of the target
  below the window and the point is inside the target's frame.
- An element whose center is clipped (a long non-wrapping line in a narrow column) is clicked at
  the center of its VISIBLE part (`visibleX`/`visibleY` on the row) instead of being refused.
- A drag verifies only its start point against an enabled control; later points just stay in the
  window, so passing over a disabled button no longer aborts the drag.
- A synthetic drag in a BACKGROUND window does not drive a SwiftUI `DragGesture`. Give the control
  an accessibility adjustable action or a named action and use that instead.
- A background Cmd+C does nothing: a background app has no key window. To prove what a copy would
  put on the clipboard, read the element's `AXSelectedText` after a background drag-select.

`--prepare --target-key OBSERVED_KEY` rebinds one matching target inside the same process and
window before focus/reveal. It does not permit arbitrary repair. Browser document and nearby
row text participate in fingerprints. Changed or ambiguous targets refuse. `--prepare` does
not make coordinate evidence survive a layout change.

Pressing an `AXMenuButton` or `AXPopUpButton` opens an in-window menu, and that is not an ordinary
press. `AXUIElementPerformAction` returns before the menu exists, so the press waits for the menu
to arrive and reports `menuOpened`; if the press was swallowed it presses once more, only after a
fresh read proves no menu is open, and reports `menuPressRetried`. A `perform` of `AXShowMenu`
behaves the same way. If no menu is seen even then, the result is `ok: false` with an `error`: the
action WAS dispatched, so inspect the window rather than repeating it. `--refresh` waits up to three
seconds for the menu rows and reports `after.awaited {what, arrived, timeoutSeconds}`. A press
TOGGLES, so pressing a control whose menu is already open is refused rather than silently closing
it. Close it with `--action perform --ax-action AXCancel` on that same control: the open `AXMenu`
carries no identifier of its own, so the action is delegated to it, and a menu that is already
closed answers `menuAlreadyClosed` instead of failing.

`see` exposes raw keys such as `AXTitle`, `AXDescription`, `AXIdentifier`, `AXValue`, `AXModal`;
the API uses normalized `label`, `identifier`, `value` and actions `{raw,name}`. Do not print
objects with `join()` and lose the AX action name. Native booleans often arrive as `"0"`/`"1"`.
API refs, native indexes, OCR refs and annotation-box numbers are different namespaces.

Snapshots pin process launch, window, tree, scope and age. Window IDs survive reordering,
not closure. `--window-index`, `--window-id` and `--window-title` are alternative selectors.
`--window-title` refuses missing/ambiguous matches. Depth is bounded; no fabricated partial
tree references. `--scope chrome` avoids traversing page contents. `--no-image` is appropriate
for AX-only work; coordinates require screenshot evidence.

`see --since previous.json` returns changed rows and an index map, plus a fresh token. Do not
mistake changed rows for a full candidate inventory. `bulk:true` means the fast read;
structural gaps fall back to the normal walk. `AX_TOOL_NO_BULK=1` is a diagnostic comparison.
Neither path may silently erase a modal. Snapshot action guards reject covered targets.

## Coordinates, OCR and cursor feedback

Native `act --coords X,Y` uses global logical screen points inside the pinned window. API
coordinates default to screenshot pixels with a top-left origin. Convert using the captured
window bounds and actual image size:

```text
screenX = window.x + imageX * window.width / screenshot.width
screenY = window.y + imageY * window.height / screenshot.height
```

Do not assume a fixed Retina scale; displays may differ and origins may be negative. Capture
identity/geometry/pixels are revalidated. Visual evidence is one-use and expires; changed
pixels require a new observation. Never normalize away a real page change to pass a guard.

```bash
tools control screenshot --app APP --window "EXACT TITLE" --path /tmp/window.png
tools control ocr --app APP --window "EXACT TITLE"
tools control cursor preview --coords X,Y
tools control cursor hide
```

`cursor preview` displays feedback without clicking. Named `cursor move/click/show` uses
validated snapshots and global points; it does not move/restore the hardware pointer.
Feedback routes to the target display and refreshes after display changes. Screenshots alone
do not prove that an overlay appeared at every action; review a recording when that is the claim.

`screenshot --annotate` draws numbered boxes, whose numbers are not action indexes.
`draw` works on existing image pixels and supports highlight/box/ellipse/arrow/label/blur/crop/grid;
use its help for the annotation schema. `compare-screenshot` exits 0 within the threshold,
1 over it, 2 for unusable inputs. These commands are not native plan-step verbs.

## Plans and recording

`control run plan.json` uses sequential selector actions, optional `saveAs` references,
`stopOnFail`, and assertions. Validate with `--dry-run`. It is not the standalone TypeScript
runner and does not automatically inherit snapshot-ref guarantees. Check `failedSteps` and
each step, not just process exit. Mutation retries are refused; read retries must be bounded.
`record-plan` is machine-global: other sessions can contribute foreign actions. Review and
exclude foreign entries before any replay.

`snapshot --json` stores mouse/foreground state for `restore`; it is not a `see` token.
`restore` can move the physical pointer and foreground app, so use it deliberately. A verified
window-specific action should not be replaced with an unrelated frontmost-app shortcut.

For multi-frame capture read [capture.md](capture.md). Native capture uses the standalone
API for its action controls and fails without switching to Peekaboo or AppleScript.
