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

| Native action | Extra arguments | Focus |
| --- | --- | --- |
| `get` | none | Read only |
| `press` | exposed AXPress | Native AX; no required foreground |
| `perform` | `--ax-action` from observed action list | Depends on the exposed action |
| `set` | `--value` | Exact AXValue/native popup selection; no keyboard fallback |
| `focus` | selected element/window | Explicit activation |
| `click` | `--button`, `--double`, `--background`, `--coords` | Foreground unless explicitly background |
| `move`, `drag`, `scroll` | Fresh geometry; see help for direction/destination | Window-addressed; no hardware-pointer assumption |
| `select` | unique `--text`, context, range or selection mode | AX selection must actually be settable; preparation may be needed |
| `paste` | `--text`, `--format`; `--replace --prepare` for replacement | Focused field, clipboard restoration, exact replacement readback |
| `type`, `key` | `--text` or `--keys` | Correct app/window/input must be focused |

`--prepare --target-key OBSERVED_KEY` rebinds one matching target inside the same process and
window before focus/reveal. It does not permit arbitrary repair. Browser document and nearby
row text participate in fingerprints. Changed or ambiguous targets refuse. `--prepare` does
not make coordinate evidence survive a layout change.

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
