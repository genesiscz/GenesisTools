# ax-tool

Compiled Swift CLI for macOS UI automation via the Accessibility (AX) API. Element-targeted, cursor-free where possible, ~10-30x faster than osascript/System Events (~66ms get, ~130ms list, ~151ms press vs 2-5s).

Consumed by the `tools ax` TypeScript wrapper (`src/ax/`) — prefer that interface; it auto-builds this binary on first run. Direct binary use is identical minus the human-friendly output formatting.

## Build

```bash
swift build -c release            # from this directory
# or from repo root:
bun run build:native
```

Binary lands at `.build/release/ax-tool`. Requires Swift 5.9+, macOS 13+.

## Permissions

Needs **Accessibility** access for the calling process (System Settings > Privacy & Security > Accessibility). `screenshot` additionally needs **Screen Recording**.

## Commands (24)

| Group | Commands |
|-------|----------|
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
- Session handoff/history: `.claude/plans/2026-07-18-AxToolHandoff.handoff.md`


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
