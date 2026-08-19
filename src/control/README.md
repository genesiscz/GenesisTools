# tools control

> **macOS UI automation through the Accessibility API, plus screen recording with timed actions.**

Drives native macOS apps by addressing real accessibility elements instead of guessing pixel coordinates. It also records the screen while it drives, which is how a UI change gets a video without anyone filming it.

---

## 🛑 Run `preflight` first

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
| `click` | CGEvent click at the element centre, no coordinates needed |
| `perform` | Perform any AX action on an element, the generic form of `press` |
| `set` | Set the value of a text field |
| `type` | Type keystrokes and hard-verify the result |
| `hotkey` | Send a key combo via CGEvent |
| `scroll` | Send wheel events with `--direction`, or scroll an element into view without it |
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
| `capture` | Screen recording with timed UI actions, crop compositing and vitrinka publish |

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

This tool needs macOS Accessibility permission for the process that runs it, and Screen Recording permission for the capture and screenshot paths. A missing permission usually presents as an empty element list rather than an error, so if `list` returns nothing for an app you can see, check permissions before debugging selectors.

⚠️ A runtime upgrade (a new `bun` or `node` binary) silently revokes previously granted permissions, because the grant is per-binary. Re-grant after upgrading.

## Notes

- `tools macos control` reaches the same functionality through the macOS umbrella tool.
- The `macos-control` skill wraps this tool with the discovery-first workflow and the frame-by-frame review loop for recordings.
- `hittest` is the tie-breaker when a click "works" but the wrong thing responds. It reports which element the system would actually deliver the event to, which is not always the element you targeted.
