# tools control

> **macOS UI automation through the Accessibility API, plus screen recording with timed actions.**

Drives native macOS apps by addressing real accessibility elements instead of guessing pixel coordinates. It also records the screen while it drives, which is how a UI change gets a video without anyone filming it.

---

## Snapshot-scoped inspection and actions

Prepared `act` calls carrying `--target-key` can recover from typed stale/focus refusals only when
native dispatch is confirmed `not_started`. The shared sync/async runner reuses the original token
and fingerprint, allows two retry starts within 1.5 seconds of the first refusal, and reports a
`recovery` receipt. Attempts and readback share the original deadline. It does not repeat completed steps, unknown input, coordinate
clicks, or Jev decisions. Unstable screenshot reads have a separate bounded read-only recovery;
post-action observation failure never authorizes repeating the action.

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

## iOS Simulator (`control sim`)

The same observe / decide / act / readback contract, against a booted iOS Simulator instead of a
macOS window. `SimulatorControlDriver` implements the same `ControlDriver` interface as the macOS
driver and produces the same `Observation`, so the admission gate, Jev's classification, the
freshness rules and the readback are the shared ones — nothing above the driver knows the screen
is a simulator.

```bash
tools control sim devices                                    # booted simulators, with udids
tools control sim launch --bundle-id com.apple.mobilecal     # launch, or bring to the front
tools control sim see --bundle-id com.apple.mobilecal --out screen.json
tools control sim act --snapshot-file screen.json --element 10 --action press
tools control sim act --snapshot-file screen.json --element 12 --action type --text "Standup"
tools control sim act --snapshot-file screen.json --element 19 --action scroll --direction down --pages 1
tools control sim screenshot --path screen.png
```

`--simulator [udid]` also reaches the Jev decision commands, so the autonomous loop runs against a
simulator with no other change:

```bash
tools control assist --simulator --bundle-id com.apple.mobilecal --task "create an event titled Standup"
tools control resolve --simulator --intent "the button that adds an event"
```

**Requires `idb`** (`brew install facebook/fb/idb-companion`). The macOS Accessibility API cannot
see inside the simulator's rendered surface; the measurement is in `docs/benchmarks-simulator.md`.

How a screen is read: `idb ui describe-all` returns only the elements an app publishes at the top
of its accessibility hierarchy, which for iOS Calendar's day view is 5 rows and no Add button. The
leaves are recovered by sweeping a bounded grid of `describe-point` hit tests, which returned 32
elements on the same screen including `add-plus-button`. `--probe-step`, `--max-points` and
`--no-probe` control that sweep; a sweep cut short by its budget is reported as
`probe.truncated: true` and never presented as a complete screen.

Freshness: `src/control` treats `Observation.snapshot` as an opaque string, and the macOS
guarantee comes from a tree digest inside `ax-tool`. The simulator driver enforces its own
equivalent — a hit test at the exact point about to be tapped. If the element there is no longer
the element that was decided on, the act is refused as `not_started` rather than landing on
whatever moved into its place. The CLI door additionally re-resolves the chosen element in a fresh
read before dispatching, so a decision made against a screen that has since changed is discarded:

```
The chosen element (id:add-plus-button) is no longer on screen.
The screen moved while the decision was being made; observe again.
```

Supported actions are `press`, `click`, `focus`, `type`, `key` and `scroll`. `set`, `paste`,
`select` and `perform` are refused by name rather than approximated.

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

## Independent Computer Use API

`tools computer-use mcp` exposes the native API as stdio tools; `tools computer-use mcp --repl` preloads `computer` in the persistent repository REPL. `tools computer-use run --file task.ts` runs one script. App/window inventory, native menu refs, state/diffs, paging, input, generic sequences and OCR use the same backend. See [the standalone API guide](../computer-use/README.md).

Run `tools computer-use prepare` once before latency-sensitive work. The repeatable native CPU/call-count benchmark is `bun src/control/scripts/live-smoke.ts --background-only --benchmark`; it spends no AI requests and verifies every fixture write.

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

### Replay and structured form filling

```sh
tools control replay --list
tools control replay context --chooser jev --provider typesafe
tools control replay completed --chooser mock
tools control fill --app Fixture --window-id 42 --data fields.json --provider typesafe
```

Replay accepts a built-in case ID or a labeled JSON fixture. It is always decision-only, with zero native actions. The fixture oracle checks the pipeline using known labels; it is not a model accuracy benchmark. The dashboard Control tab compares exact-label matching, the oracle and Jev. Missing provider cost is shown as unknown, never estimated as free.

Fill accepts an object of 1–20 supplied string values, such as `{"Full name":"Alice Example","City":"Prague"}`. It maps keys to observed writable text fields, keeps the values out of model requests, sets each exact value, reobserves after each attempt, and verifies final readback. Bindings must be unique and one-to-one. Secure inputs, unsupported dropdowns, masked readback and ambiguous fields stop the run. It never presses Submit or types generated text. Use `--max-fields`, `--max-requests`, `--timeout` and Ctrl-C to bound it. Partial progress is returned on failure.

### Bounded tasks

```sh
tools control assist --app Editor --window-id 42 --goal "Open preferences and enable line numbers" --max-steps 4 --max-requests 10 --provider typesafe
tools control assist --app Fixture --goal "Enable Show line numbers" --exact-id line-numbers --exact-value 1
```

Assist admits observed AXPress actions only. Each attempt uses the current native snapshot, then obtains a fresh observation in the same process/window. It stops on abstention, uncertainty, unchanged state, cancellation, deadline or budget exhaustion. A reobserve decision is allowed once. Failed or partially delivered native actions are never retried. Goal completion is reported with an explicit exact or semantic verification basis.

Defaults are 8 action attempts, 20 model requests and 120 seconds. Native commands are individually capped at 10 seconds; Ctrl-C stops the model call/next iteration, with an in-flight synchronous native call allowed to return within its cap. First-use native compilation is separately bounded by the existing two-minute build limit. Text entry belongs to `fill`; arbitrary generated text, shell commands, coordinates and automatic focus changes are not supported.

`bun src/control/scripts/live-smoke.ts --background-only --semantic` runs the real TypeSafe provider against a temporary AppKit fixture. It requires TYPESAFE_API_KEY, Accessibility and Screen Recording, makes paid requests, and terminates only its own verified fixture PID.

### Observe fan-out

```sh
tools jev control observe --app Fixture --goal "Enable Show line numbers"
tools control assist --app Fixture --goal "Enable Show line numbers" --no-fanout
```

`tools jev control observe` (`observeFanout` in `src/control/lib/decision/observe.ts`) takes one
`see` and asks six questions in a single request: which target, which verb, whether the goal is
already done, whether the view is blocked, whether to wait, and the risk of acting. Code branches
on the answers instead of picking a target and separately judging the outcome.

`control assist` uses this fan-out by default and keeps the same serial guards the older chooser
path has always had: a checkbox or toggle is never dispatched twice while completion stays
unverified (the double-toggle guard), a refusal goes through the bounded `RecoveryController`
before giving up, and when an action produces no observable change between the before and after
evidence, assist stops and asks a final `judgeOutcome` rather than repeating the action. Pass
`--no-fanout` to restore the older serial chooser (`chooseCandidate` then a separate judge) for
comparison.

A refuted exact readback returns `{ status: "blocked", reason: "exact_readback_refuted" }`
(`src/control/lib/decision/observe.ts`).

### Animated action cursor

Applicable mutations show the bundled MIT-licensed Cua Default 2.0.0 vector cursor: cyan fill, white outline, soft glow, gentle float, animated action marks and a fading GenesisTools badge with foreground/background and AX/pixel context. Movement glides between resolved targets. Drag feedback follows delivered gesture points.

This covers snapshot press/click/move/drag/set/perform/focus/scroll/type/key/select/paste, named software cursors, Jev fill/assist, and legacy targeted mutations and window actions. Targetless typing/hotkeys animate at the last known cursor location; they never invent a new target. Read-only commands stay quiet.

The click-through native overlay never moves the physical pointer or activates a target app. It is best-effort feedback, not proof of action success. Core Animation drives motion without an idle rendering timer. The helper fades and exits after 20 seconds without actions, with a ten-minute absolute lifetime; a future action starts it again. Invalid or refused native targets retain all existing admission checks.

Feedback now waits up to 1.5 seconds for an event-specific receipt after the helper submits its layers, finishes the glide and receives two display callbacks. The display link stops when receipts are complete. Set `GENESIS_CONTROL_CURSOR_WAIT=required` for demonstrations: missing geometry, disabled feedback or a missing receipt stops input. Ordinary mode reports feedback failure and remains best effort. Drag waits before mouse-down, then streams samples. Snapshot/menu/pointer targets are revalidated after waiting; feedback never overrides stale-state refusal.

`live-smoke.ts --task-benchmark` compares complete stepwise and compound public-API tasks on a disposable fixture, with explicit TypeSafe Jev requests and exact final-state checks. It alternates order and retains the first pair separately. Add `--host-paced` for a single pair with actual stdin host dispatch boundaries, including their wait time. This measures the specified task and orchestration; it does not call another computer-use provider or establish universal speed parity.

```sh
tools control act ... --no-cursor
tools control cursor hide
GENESIS_CONTROL_CURSOR=off tools control ...
GENESIS_CONTROL_CURSOR_MOTION=off tools control ...
```

Reduced Motion follows the macOS accessibility setting; the environment override forces still artwork. `--no-cursor` also works on `tools jev control` commands. The artwork and Inter font are bundled assets, not AI models; there are no runtime downloads. Provenance, original source archive, licenses and the offline regeneration script are in `native/ax-tool/CursorAssets`.

The same complete command set is available through `tools jev control` while using the linked Jev worktree. For example, `tools jev control cursor hide` and `tools jev control act … --no-cursor`.

Visual proof: `bun src/control/scripts/live-smoke.ts --cursor-proof` records five seconds of native press/set/press feedback on a disposable fixture. It is separate from `--background-only --verify-pointer`, which checks pointer and foreground invariants without the recording's foreground text entry.


### Generic persistent sessions and sequences

`sequence` applies one user intent to a bounded observed target set. It keeps native AX references and the Jev client loaded, so each action does not restart the helper, capture a screenshot or hash an unrelated transcript. Targets can be buttons, tabs, rows and other AXPress controls; the command is not tied to folders or a particular app.

```sh
tools jev control --provider typesafe sequence "Click all the browser tabs." \
  --app com.brave.Browser --role AXRadioButton --within AXTabGroup --within-index 0 \
  --window-ids WINDOW_ID --scope chrome --verify selected --interval 120 --restore-selected
```

Obtain current window IDs and root order with `see --scope chrome`. Choose a root index only from that observation. `--focus` explicitly focuses the window before binding. `--restore-selected` restores the target selected at observation time. A transient find bar can replace the browser's accessible root; dismiss it through its observed native close control before starting a new sequence. No browser scripting API or AppleScript is used.

The model answers a typed target-set matching question using native control descriptions, scope and labels. It does not generate action arguments. Matching uses the existing 0.8 target-selection probability floor; completion is independent, exact native readback of the requested boolean attribute. The ordinary `judge` completion threshold is unchanged.

The native helper checks process launch, window identity, retained target membership, enabled state and AXPress support before every dispatch. Replaced parent containers can be rebound only when they still contain the retained target. Missing targets and ambiguous scope stop. Each batch retains successful and failed step results; no uncertain mutation retries. Sessions have a 120-second execution lifetime, 200-action cap and bounded IPC timeouts. Root/window IDs are observation data, not saved authorization.

Two Brave windows with identical geometry are distinguished by their native AX window IDs, with the prior strict frame matching retained as fallback when that OS capability is unavailable.

Live measurement on 2026-09-18: Jev plus native AXPress activated and read back all 74 tabs across two Brave windows in 10.24 seconds, then restored the selections present at the start of that run. This is a small warm desktop measurement; it excludes development and cold native compilation.

For persistent agent use, import `NativeControlSession` from `src/control/lib/decision/native-session.ts` inside the repository's `tools node-repl` runtime. Keep the instance across REPL calls:

```ts
const { NativeControlSession } = await import("/absolute/GenesisTools/src/control/lib/decision/native-session.ts");
const control = new NativeControlSession({ app: "com.brave.Browser", provider: "typesafe" });
const view = await control.observe({ role: "AXRadioButton", rootRole: "AXTabGroup", rootIndex: 0,
    scope: "chrome", windowId: currentWindowId });
const plan = await control.chooseAll("Click all the browser tabs.");
await control.batch({ steps: plan.targets.map(target => ({
    target, verifyAttribute: "AXSelected", verifyValue: true,
})), intervalMs: 120 });
control.close();
```

The repository's Bun-based REPL supports TypeScript imports. A different host's Node REPL may only accept compiled JavaScript. The measured repository REPL setup took 178 ms; a later call reused its bindings and completed Jev plus two native presses and restoration in 1.04 seconds. Keep sessions short; create a fresh one after expiry or cancellation.

### Semantic waits

```sh
tools jev control await --app Editor --window-id 42 --condition "A saved confirmation is displayed" --timeout 30000 --max-requests 12 --provider typesafe
tools jev control wait-replay ready --chooser oracle
tools jev control wait-replay unchanged --chooser jev --provider vercel
tools control see --app Editor --window-id 42 --no-image
```

`await` pins the process launch/window and batches loading, ready, blocked, failed and evidence questions. Readiness requires an observable condition and admitted evidence; it does not prove hidden server or filesystem state. Failure and human-input blockers take precedence. A loading classification is advisory; terminal states require an admitted witness. Uncertain evidence stays uncertain.

AXObserver notifications wake the reader where supported, with a bounded one-second snapshot fallback for missing notifications and a short event debounce. Repeated observations create no PNG files. Geometry, element indexes, capture metadata and other non-semantic fields do not cause another model request. Readable native control kinds accompany raw AX roles in model inputs. A monotonic deadline, cancellation and request budget bound every run. A stable spinner produces “no observed progress,” not a claim that the app is dead.

For exact local readiness, add `--exact-id status --exact-value Saved --max-requests 0`. This uses the same bounded native event loop and makes no AI calls. The independent API offers the same check as `computer.await_condition({app,condition:"Save finished",exact:{identifier:"status",value:"Saved"},max_requests:0})` after observing the target window.

The dashboard's Semantic waits card and `wait-replay` run the same wait core with a virtual event source. The oracle verifies plumbing without a model. Live Jev runs retain probabilities and evidence decisions, including uncertainty; no desktop action is dispatched by replay.

### Bounded recovery

`tools jev control assist --app APP --goal "Enable line numbers" --recovery bounded --max-recoveries 2`

Recovery uses native delivery metadata. A stale snapshot or missing target may be reobserved and decided again; an unknown/partial mutation, changed app/window, permission or authentication barrier stops. Normal request/action budgets also cover recovery. A successful no-op is never repeated.

Optional `--remedies remedies.json` admits explicit local dismiss/back controls only:
`[{"id":"close-help","kind":"dismiss","identifier":"help-close","label":"Close help","role":"AXButton","description":"Close the help overlay"}]`.
The identifier, role and label must uniquely match fresh state. There is no default generic Cancel/Back click. The result preserves the refusal, evidence, supplied remedy set, model choice and recovery action result.

### Resilient workflow replay

`tools jev control replay-plan workflow.json --values values.json --rebind --window-id 123`

A version 1 plan binds each step against a fresh observation, first by an exact unique selector, then (only with `--rebind`) by Jev. Every step has a required postcondition and `noRetry: true`. Unknown dispatch/readback stops the run. Repaired selectors stay in the result unless a verified run explicitly uses `--save-repairs new-plan.json`; the original is never overwritten.

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

Exact values come from a separate local file such as `{"name":"Example Person"}`. Choosers see field descriptions and redacted inputs, never this values map. Set steps also verify the exact written value before the recorded postcondition. Missing values are rejected before any desktop observation/action.

`record-plan stop --semantic metadata.json --out workflow.json` attaches the same versioned metadata to a recording after checking every recorded action, selector, app and fixed parameter. A key chord cannot change during attachment, and unsupported side effects such as legacy `--return` are refused instead of dropped. Inline values are replaced by references in the emitted plan. No observations or screenshots are retained automatically; optional context contains only caller-supplied role/label pairs. Existing raw recorder logs retain their existing lifecycle. Plans support `press`, `set`, `click`, `focus`, `key`, `type`, `paste`, `select`, `scroll` and an exposed AX `perform`. `parameters` carries fixed verb-specific arguments such as `{"keys":"super+a"}`, `{"direction":"down","pixels":80}` or `{"axAction":"AXShowMenu"}`. Text actions use local `valueRef` values. Exact postconditions may specify `attribute` as `AXValue`, `AXFocused`, `AXSelected`, `AXExpanded` or `AXSelectedText`. Semantic postconditions require explicit `--jev` or `--rebind`. Unsupported recordings fail explicitly. The legacy `run` path remains available for old plans and refuses semantic plans rather than ignoring their postconditions.

### Exact → Jev → host chooser

`tools jev control choose --app APP --intent "Refresh" --chooser auto`
resolves a unique exact label locally, otherwise asks Jev once. It returns separate coverage, conflict, probability, margin and confidence signals. Uncertain or conflicting choices return a bounded redacted evidence packet. **Jev is the only AI model called by control**, through either direct TypeSafe or Vercel Gateway. A host handoff makes no extra AI API request.

`choose` defaults to `--chooser exact` (no AI). Exact-only assist additionally requires `--exact-id`/`--exact-value` and recovery off, so it cannot silently invoke semantic judgment. `assist --chooser auto` uses the same chooser and keeps native validation and shared budgets. `--host-decision decision.json` accepts `{"packet": <original packet>, "answer": {"packetId": "...", "choice": "c0", "evidence": ["e1"]}}`; changed or expired observations, invented IDs and extra action fields are rejected. The tool never requests shell code, coordinates or new payloads from the host.

`tools jev control compare-choosers --jev --split held-out` explicitly enables Jev on the same fixed synthetic cases used by exact and auto. Without `--jev`, comparison is exact-only. Development and held-out cases are reported separately; this small corpus is a smoke check, not a desktop accuracy benchmark.

Add `--split all --calibrate` to collect each case/mode once and replay four conservative threshold policies locally. The report selects using development labels only (fewest wrong choices, then most correct outcomes), reports held-out accuracy/abstention and host handoffs, and preserves default policy on ties. No additional requests are made for the policy sweep, and live action thresholds remain unchanged. The HTTP comparison endpoint accepts the same `calibrate:true` flag with `jev:true, split:"all"`. Missing provider usage/cost is reported as unknown, not zero. These ten synthetic cases do not establish real-world accuracy, fewer actual assistant turns or universal speed parity.

### Native recording

The default capture backend uses ScreenCaptureKit and the independent ComputerUse API for timed input. Build/start failures stop without changing backend. Native preflight, focus, crop lookups and action dispatch do not call Peekaboo or AppleScript. URL scripting, raw osascript and media-key rewrites are rejected before recording starts. Native input requires an explicit app and an unambiguous window/target. The old behavior remains available only through an explicitly selected `capture.backend: "peekaboo"`.

### Native visual grounding

`tools control see --app APP --window-id ID --perception ocr` adds local macOS Vision OCR. `--perception-crop x,y,w,h` and `--perception-width 400` crop/resize only the OCR input; rectangles map back onto the original screenshot. Known AX text inputs are excluded from OCR candidates. No Python, icon model, download or external vision API is involved.

`tools jev control visual --app APP --window-id ID --intent "Paint" --chooser auto` captures and chooses only. Add `--click` to explicitly dispatch one click; `--background` requests window-addressed delivery. Exact is the default chooser and makes no AI call. Jev receives observed OCR labels/rectangles and can return only a region ID, never coordinates or action arguments.

For direct control, `act --snapshot TOKEN --region v0 --action click` uses an observed region. Raw `--coords` and drag destinations also require screenshot-backed evidence. Native code checks process/window identity, exact window geometry, pixel dimensions and current pixel hash, then atomically consumes the capture before posting input. Visual captures expire after **30 seconds** and permit **one coordinate action** (a double click/drag is one bounded action); ordinary AX tokens retain their 120-second limit. Run see again after an action. A reused capture fails before another screenshot is taken.

Dispatch and task completion are separate: visual output says `verification: unverified` until the caller checks a postcondition. An unchanged AX tree is insufficient when canvas pixels changed. Source PNG hash, pixel hash, original dimensions, crop/resize transform and logical screen rectangles are returned for inspection. Used-capture markers live in the private temporary control directory.

Live proof: `bun src/control/scripts/live-smoke.ts --background-only --visual --visual-jev` uses an isolated native fixture, checks pixel-only change refusal, cross-process one-use admission, crop/resize geometry, known-input exclusion and a real Jev-guided OCR click. `--visual-jev` explicitly enables that paid Jev call.
