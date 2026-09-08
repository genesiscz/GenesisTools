# ax-tool

Compiled Swift CLI for macOS UI automation via the Accessibility (AX) API. Element-targeted, cursor-free where possible, ~10-30x faster than osascript/System Events (~66ms get, ~130ms list, ~151ms press vs 2-5s).

Consumed by the `tools control` TypeScript wrapper (`src/control/`). It builds a missing or stale binary. Direct binary use returns JSON and works without Codex, Sky, Peekaboo or an agent session.

## Observe and act

`ax-tool see --app APP [--window-index N | --window-id ID] [--path PNG]` returns an indexed AX tree and screenshot for one explicit window, plus a 120-second observation token. Multiple windows require an index from the current candidates. `ax-tool act --app APP --snapshot TOKEN --element N --action press` resolves only that observation after validating process start time, CG window ID, tree digest, age and bounds. Run `see` again before the next action.

Actions: get, press, click, drag, set, perform, focus, scroll, type, key, select and paste. Read `ax-tool --help` for their arguments. `click` checks focus, geometry, scroll clipping and hit ownership. `type`/`key` are process-targeted and require the intended input/window already focused. `set` writes AXValue and verifies it without a typing fallback. AX failures/timeouts fail explicitly; an acknowledgment still needs UI verification.

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

Needs **Accessibility** access for the calling process (System Settings > Privacy & Security > Accessibility). `screenshot` additionally needs **Screen Recording**.

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

## Extended snapshot actions

`drag` uses the left mouse button, `--to X,Y`, optional `--duration 0.1..5`, `--coords` and `--background`. Only `click` accepts `--button left|right|middle`.

`scroll --direction up|down|left|right` derives wheel distance from the observed viewport with `--pages 1..20` (default one), or uses exact `--pixels 1..10000`. The modes are mutually exclusive and both support coordinates/background delivery. Page mode resolves the nearest receiving AX scroll-area viewport at the verified point; it refuses and requests `--pixels` if that viewport cannot be established.

`select` accepts a UTF-16 `--range START,LENGTH` or a unique literal `--text MATCH`, with optional `--prefix`/`--suffix` describing the immediate surroundings of a text match. `--selection text|cursor_before|cursor_after` chooses the range or caret. These are select-only options.

`paste --text PAYLOAD --format text|md|html` uses the focused input's current selection. Select another range or caret through `select → see → paste`; selection flags on paste are rejected. `type` rejects more than 256 UTF-16 code units before dispatch; use paste for longer text.

Clipboard restoration skips observed competing writes, but remains best effort because AppKit has no atomic compare-and-swap. HTML paste also supplies raw markup as plain text, so rich rendering depends on the receiver.

## Tests

`bun run test:native` runs the SwiftPM test targets (`swift test` in `native/ax-tool`). CI runs
on ubuntu, which has no Swift toolchain, so these tests are a local gate: run them before pushing
a change under `native/ax-tool`.