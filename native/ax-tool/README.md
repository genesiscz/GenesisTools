# ax-tool

Compiled Swift CLI for macOS UI automation via the Accessibility (AX) API. Element-targeted, cursor-free where possible, ~10-30x faster than osascript/System Events (~66ms get, ~130ms list, ~151ms press vs 2-5s).

Consumed by the `tools control` TypeScript wrapper (`src/control/`). It builds a missing or stale binary. Direct binary use returns JSON and works without Codex, Sky, Peekaboo or an agent session.

## Observe and act

`ax-tool see --app APP [--window-index N | --window-id ID] [--path PNG]` returns an indexed AX tree and screenshot for one explicit window, plus a 120-second observation token. Multiple windows require an index from the current candidates. `ax-tool act --app APP --snapshot TOKEN --element N --action press` resolves only that observation after validating process start time, CG window ID, tree digest, age and bounds. Run `see` again before the next action. Both accept `--budget-ms N`, the caller's deadline (the TypeScript runner passes each attempt's own): a walk that runs out stops with "observation budget ran out after N elements" rather than being killed, and the post-action refresh of `act --refresh` gets its own 4 s phase budget so a dispatched action always reports back. `window` lists each window's attached sheets.

Actions: get, press, click, move, drag, set, perform, focus, scroll, type, key, select and paste. Read `ax-tool --help` for their arguments. Pointer actions always check geometry, scroll clipping and hit ownership; they require window focus unless `--background` is supplied. `type`/`key`/`paste` are process-targeted and require the intended input/window already focused. `set` writes AXValue and verifies it without a typing fallback. AX failures/timeouts fail explicitly; an acknowledgment still needs UI verification.

This detects changes in observable state, not replacement of otherwise indistinguishable anonymous controls. It cannot lock the desktop against concurrent changes. The full workflow and examples are in `src/control/README.md` and the macos-control skill. Legacy commands retain their existing targeting; mouse/focus `snapshot`/`restore` is a separate API.

## Background coordinate clicks

`act --action click --background --coords X,Y` takes global screen points within a current snapshot's window, as an alternative to `--element N`. It performs app-scoped hit testing and sends events to the target PID and window without warping the hardware cursor or explicitly activating the app. Drag uses --to X,Y; right-click uses --button right; background delivery depends on the receiving app accepting the event. The tool does not explicitly activate or raise the app, but a foreground target may still change its own key window. Refresh and verify both the effect and any focus changes the receiving app chooses to make.

Correct window-addressed events on current macOS need the private `CGEventSetWindowLocation` symbol after assigning the global location. This ordering is also used by [WebKit's event serializer](https://github.com/WebKit/WebKit/commit/7596ac02075f631c107be8d4e0b056d236288433). The symbol is resolved dynamically, and a missing symbol causes a refusal before posting any event. The separate window-local Quartz point uses a top-left origin; the native live test checks the delivered button effect and pointer preservation. No OpenAI library is involved.

## Build

```bash
swift build -c release            # from this directory
# or from repo root:
bun run build:native
```

Binary lands at `.build/release/ax-tool`. Requires Swift 5.9+, macOS 13+.

## Permissions

Needs **Accessibility** access for the calling process (System Settings > Privacy & Security > Accessibility). `see`, `act`, `screenshot`, `ocr --app` and `capture` additionally need **Screen Recording**. A missing grant is refused with `reason` `accessibility-not-granted` or `screen-recording-not-granted` and the name of the app macOS holds responsible.

## Commands

| Group | Commands |
|-------|----------|
| Snapshot workflow | `see`, `act` |
| Discovery | `apps`, `list`, `tree`, `dump`, `find`, `window`, `attrs`, `actions`, `preflight` |
| Measurement | `typography`, `hittest` |
| Inspection | `get` |
| Interaction | `press`, `perform`, `set`, `click`, `scroll`, `focus`, `type`, `hotkey`, `screenshot` |
| Vision | `ocr` |
| State | `snapshot`, `restore`, `record` |

`hittest` takes screen coordinates and no `--app`. `apps`, `hotkey`, `snapshot`, `restore`,
`record` and `ocr --image` also run without one.

All output is JSON on stdout: `{"ok": true, ...}` or `{"ok": false, "error": "..."}`.

## Targeting

Interaction/inspection commands accept:

```
--app <name>       app by localizedName (exact > case-insensitive > bundleId substring) — required except snapshot/restore/hotkey
--id <axId>        exact AXIdentifier
--q <query>        universal cascade: id > title > desc > value > role > subrole
--text <query>     text-only cascade: id > title > desc
--role / --title / --desc / --subrole   AND-combined filters (fuzzy: "button" → AXButton)
--window <title>   scope search to one window (title substring)
--exact            strict role/subrole matching
```

Regex: wrap any value in `/pattern/flags` (e.g. `--q "/nav-.*/"`). Ambiguous `--q`/`--text` matches on interaction commands refuse with a candidates list — narrow with `--role`/`--desc`/`--window`.

## Design notes

- **`set` on text fields types via CGEvent** (click/AX-focus + Cmd+A + Delete + keystrokes) because writing AXValue directly does not update SwiftUI `@State`. Non-text elements get a plain AXValue write. Timing between Cmd+A → Delete → type is deliberately conservative (150ms/100ms) — shortening it caused partial-clear corruption. Do not tighten without approval.
- **Visibility guard**: `set`/`type`/`click` verify the element center lies inside a visible window before posting CGEvents; off-screen targets are refused (prevents keystrokes landing in whatever else is at those coordinates). Off-screen `click` falls back to AXPress/AXFocus.
- **AX focus first, CGEvent click fallback** for `set`/`type` — keeps the cursor still when the app honors AXFocused.
- **`performActionWithTimeout`** runs AX actions on a detached thread; a timeout is treated as success because actions that open menus/sheets block in a nested run loop.
- **`screenshot`** uses CGWindowList (background capture, no app activation); minimized windows capture blank.

## Structure

Single file, `Sources/main.swift` (~1400 lines): AX helpers → search/targeting (`findByAttributes`, `resolveElement`) → per-command functions (`cmd*`) → arg parsing + dispatch at the bottom.

## Docs

- Skill for agents: `plugins/genesis-tools/skills/macos-control/SKILL.md`


## Measurement commands (for automated checks)

`tree` answers "what is there". An automated check usually needs more: where is
it, is it enabled, which window owns it, is it actually on screen, and what
does it look like. These three answer that, and none of them carry any
app-specific knowledge.

```bash
ax-tool dump --app Genesis          # whole surface, ONE process
ax-tool typography --app Genesis    # rendered font/size/colour per label
ax-tool hittest --at 640,480        # what would actually receive a click there
```

**`dump`** returns `{windows:[{title,x,y,w,h}], elements:[{id,role,title,desc,
value,enabled,visible,x,y,w,h,win}]}` — FLAT, with `win` indexing into
`windows`. Unlike `tree` it carries geometry, so geometric assertions become
possible: do two controls overlap, is a control outside its own window, did a
container identifier get stamped onto its children (visible as the same id on
a frame and a frame it encloses), is a labelled control actually on screen.

`visible` is computed from scroll-clip ancestry: an element counts as visible
when its centre lies inside every `AXScrollArea` above it. AX reports a row's
full frame even when it is scrolled out of sight, so without this a footer
looks like it "overlaps" rows that are not on screen at all.

**`typography`** reads `AXAttributedStringForRange`, so the font, size and RGBA
are what the app ACTUALLY painted — theme and Dynamic Type included, no
screenshots, no OCR, no golden images to maintain.

**`hittest`** resolves the point through `AXUIElementCopyElementAtPosition` and
walks up to the nearest identified ancestor. An id existing in the tree does
not mean a user can reach it; a sheet or overlay swallows the click while every
id assertion still passes.

## Not disturbing the user

Defaults are unchanged, but every disruptive behaviour can now be opted out of:

| Flag | Effect |
|---|---|
| `--to-pid <pid>` | Route synthetic key/mouse events to that PROCESS instead of the global HID tap. Without it an event goes to whatever app owns the keyboard — i.e. it can type into the user's editor. |
| `focus --no-activate` | Set `AXFocused` without raising the app. Focusing an element does not actually require owning the keyboard. |
| `window --action close --no-raise` | Close without pulling the window forward first. AXPress on the close button works fine on a background window. |

Use all three when the tool runs unattended while someone is working. Leave
them off for interactive use, where raising the app is what you asked for.

## Taking over: the top-left corner

Push the pointer into the top-left corner of the main display (a 4-point square, the menu-bar
corner) and every command stops before its next synthetic event. Each click, key, character,
wheel step, drag step, warp and hover dwell passes one gate (`SyntheticInputGate`,
`Sources/utils/InputGate.swift`) that reads the physical pointer first. Before the command stops,
the gate posts the up of every key or button it still holds, so nothing is left pressed. A drag
posts its release at the last verified point. Typing stops between characters. `act` also checks
once before it starts, so a corner pointer blocks activation and AX actions as well. The same
applies to each press of a `control-session` batch.

The refusal is `{"ok":false,"refusal":"user_takeover","dispatchState":...}`. `dispatchState` is
`not_started` when nothing was posted, otherwise `uncertain`. The TypeScript runner never retries
it and recovery never tries a remedy for it. `GENESIS_CONTROL_ABORT_CORNER=0` turns the check off
(it is read once per process). A command that itself aims into that square (`click --coords 1,1`)
leaves the pointer there, so the next command refuses until the pointer moves.

## Extended snapshot actions

`drag` uses the left mouse button, `--to X,Y`, optional `--duration 0.1..5`, `--coords` and `--background`. Only `click` accepts `--button left|right|middle`.

`scroll --direction up|down|left|right` derives wheel distance from the observed viewport with `--pages 1..20` (default one), or uses exact `--pixels 1..10000`. The modes are mutually exclusive and both support coordinates/background delivery. Page mode resolves the nearest receiving AX scroll-area viewport at the verified point; it refuses and requests `--pixels` if that viewport cannot be established.

`select` accepts a UTF-16 `--range START,LENGTH` or a unique literal `--text MATCH`, with optional `--prefix`/`--suffix` describing the immediate surroundings of a text match. `--selection text|cursor_before|cursor_after` chooses the range or caret. These are select-only options.

`paste --text PAYLOAD --format text|md|html` uses the focused input's current selection. Select another range or caret through `select → see → paste`; selection flags on paste are rejected. `type` rejects more than 256 UTF-16 code units before dispatch; use paste for longer text.

Clipboard restoration skips a genuinely newer copy, but not a clipboard-history app re-publishing our own payload. It waits for the field to show the paste (up to 3 s) and runs on every exit path, SIGTERM included; results carry `clipboardRestore`. `--replace` proves the whole-field selection before cmd+v. It remains best effort because AppKit has no atomic compare-and-swap. HTML paste also supplies raw markup as plain text, so rich rendering depends on the receiver.

## Tests

`bun run test:native` runs the SwiftPM test targets (`swift test` in `native/ax-tool`). CI runs
on ubuntu, which has no Swift toolchain, so these tests are a local gate: run them before pushing
a change under `native/ax-tool`.


### Visual evidence

`see --perception ocr` uses native Vision OCR on the captured image. Optional `--perception-crop x,y,w,h` and `--perception-width N` preserve a source-pixel transform, and `act --region v0` targets the corresponding original-image region. Every image-backed snapshot carries a canonical pixel hash and PNG hash. Coordinate actions (and fixed drag destinations) revalidate pixels, dimensions, process/window and geometry, then claim a private one-use marker atomically. Visual evidence expires after 30 seconds. `see --no-image` remains the fast AX-only path and cannot authorize coordinate actions.

`see --perception ocr --perception-reuse PATH` keeps the previous read in a cache file (JSON, owner-only, replaced atomically after every read) and re-reads only what changed. The capture is compared with the previous one on a 1/8 grayscale thumbnail in 256-pixel tiles. Changed tiles are grouped into blobs, and each blob becomes one rectangle, padded by a tile and grown past any known line it would cut. At most 4 rectangles are read. More than 60% of the tiles changed, or rectangles covering more than 60% of the region, means a full read. A different pid, launch, window, window bounds, crop or processed size is always a full read, and so is a missing or unreadable file. A previous line is kept only when no re-read rectangle touches it and the gray pixels under it are byte-identical in the new capture, so every returned region, reused or fresh, is text this capture shows and is bound to this capture's identity and pixel hash. The result reports `perception.ocrReuse`, for example `{"mode":"partial","rects":2,"readFraction":0.22}`, `{"mode":"unchanged","rects":0,"readFraction":0}` or `{"mode":"full","reason":"key_changed",...}`. The reasons are `no_cache`, `unreadable`, `key_changed`, `too_much_changed` and `rects_too_large`. The mechanism is ported from typesafe-computer-use (`perception.py`). This port adds two stricter checks: a tile with any single thumbnail pixel changed by more than 16 counts as changed, and the pixel check on each kept line.

An image-backed `see` marks an actionable row `"drawn": false` when the capture shows nothing where the row says it is. That is a CSS-clipped panel or a closed dropdown's search box: Accessibility reports it as visible, but a press lands on empty page. Candidate rows are buttons, links, text fields and areas, combo boxes, pop-ups, checkboxes, radio buttons, menu buttons and cells, plus any row with an action other than AXScrollToVisible or AXShowMenu. A row qualifies only when it is visible in its scroll clip and its frame maps wholly into the capture. Blank means the inside and the left and right edge strips (read 4 pixels in from the top and bottom) all have a gray spread of 12 or less. A drawn or undecidable row gets no key. At most 400 rows are checked per snapshot. The key is added after the tree digest, so it never changes the snapshot token.

No Codex Computer Use, Sky, Python or icon-parser API is used. AI target choice lives in the TypeScript Jev layer; the native layer accepts only observed region IDs or explicit caller-supplied coordinates and verifies the capture.

Extended live probe: `bun src/control/scripts/live-smoke.ts --background-only --visual --visual-jev`. It mutates only its temporary native fixture and explicitly calls Jev once.
