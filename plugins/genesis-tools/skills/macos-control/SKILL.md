---
name: macos-control
description: Control macOS UI via the Accessibility API and record short screen captures reviewed frame-by-frame. Use when automating native apps — clicking buttons, filling forms, reading element state, finding elements, getting window bounds — or when the user wants a short screen recording of an animation/transition/flicker reviewed via a contact sheet, optionally pushed to a vitrinka board. Triggers on "click button in app", "fill form in native app", "automate macOS app", "list UI elements", "find button", "read text field value", "get window position", "interact with native app", "record the screen", "capture this transition", "Xs recording", "Nfps", "watch this animation", "why does it jump/flicker", "record this app for a few seconds", "push the recording to a board".
---

# `tools control` — macOS UI automation + screen recording

Fast native CLI for reading and controlling macOS app UI via the Accessibility API (10-30x faster than osascript: ~66ms get, ~130ms list, ~170ms press vs 2-5s), plus a recording runner (`tools control capture`) for multi-frame captures with timed actions. `tools macos control` is an alias.

Resources in this skill: `references/capture.md` (recording discipline — read before writing capture plans), `references/peekaboo.md` (peekaboo flag tables), `references/vitrinka.md` (optional board publishing).

## Commands

### Discovery (find elements you want to interact with)

```bash
tools control preflight --app <name>                 # RUN THIS FIRST — screens, frontmost, windows,
                                                     #   elements by role, browser tab, suggested plan
                                                     #   --wanted screens,windows,elements[,elements:<Role>],browser,frontmost,plan
tools control apps                                   # Running apps — valid --app values
tools control list --app <name> [--depth N]          # Flat list of all elements (max 2000)
tools control tree --app <name> [--depth N]          # Hierarchical nested tree (shows parent-child)
tools control find --app <name> --role button        # Fuzzy: "button" matches AXButton
tools control find --app <name> --title "Save"       # Find by title (substring, case-insensitive)
tools control find --app <name> --text "YouTube"     # Search title+desc+value at once (OR)
tools control find --app <name> --desc "Chat"        # Find by description (many SwiftUI elements use this)
tools control find --app <name> --subrole close      # Fuzzy: "close" matches AXCloseButton
tools control find --app <name> --role button --title "Email" --exact  # --exact forces strict role match
```

Role/subrole matching is fuzzy by default: `button` finds `AXButton`, `radio` finds `AXRadioButton`, `close` finds `AXCloseButton`. Add `--exact` when you need strict matching.

### Inspection (read element details)

```bash
tools control get --app <name> --id <axId>           # Read role/title/value/description
tools control attrs --app <name> --id <axId>         # ALL attributes with decoded values
tools control actions --app <name> --id <axId>       # Available AX actions (AXPress, AXShowMenu, etc.)
tools control window --app <name>                    # Window bounds: x,y,width,height + minimized/fullscreen
```

### Interaction (modify elements)

```bash
tools control set --app <name> <target> --value "text"                  # Set text field + HARD VERIFY (reads back, 1 retry)
tools control press --app <name> <target>                               # Press (AXPress — AX action path)
tools control click --app <name> <target>                               # CGEvent click at element center
tools control perform --app <name> <target> --action AXShowMenu         # Any AX action
tools control focus --app <name> [<target>]                             # Activate app + focus element
tools control type --app <name> --text "hello" [<target>]               # Type + HARD VERIFY ([--clear] [--return])
```

### Targeting (`<target>`)

All interaction/inspection commands accept `--id <axId>` OR any combination of `--role`/`--title`/`--desc`/`--subrole` (first match). Elements without AXIdentifier (browser tabs, toolbar buttons, window close buttons) are fully interactable:

```bash
# By AXIdentifier (native apps with .accessibilityIdentifier)
tools control press --app Genesis --id nav-chat

# By role + description (browser elements — no id needed)
tools control click --app "Brave Browser" --desc "Reload" --role AXButton
tools control click --app "Brave Browser" --desc "YouTube" --role AXRadioButton

# By description alone (Genesis settings tabs sharing the same id)
tools control press --app Genesis --desc "Account" --role AXButton

# By subrole (window close/minimize/fullscreen buttons have no id or desc)
tools control click --app Genesis --subrole AXCloseButton --window Settings

# --window scopes search to a specific window (by title substring)
tools control click --app Genesis --subrole AXMinimizeButton --window Genesis
```

## `click` vs `press` vs `set`

| Command | Mechanism | When to use |
|---------|-----------|-------------|
| `press` | AX action (AXPress) | Buttons/toggles in native apps — position-independent, works on obscured or scrolled-away elements |
| `click` | CGEvent at element center | Real mouse click — exercises hit testing, works on web content, triggers hover/focus |
| `set` | Text fields: CGEvent clear+type, then reads the field back (retry once, fail loud). Other elements: AXValue write | Text fields — verified content |
| `type` | CGEvent keystrokes | When you need real typing (autocomplete, validation, non-AX inputs) |
| `focus` | NSRunningApplication.activate + AXFocused | Bring app/element to front before typing |

### `click` scroll-safety

`click` checks if the element center is within any visible window bounds. If the element is scrolled out of view (e.g. below the fold in a scroll area), it falls back automatically:
- **Buttons**: falls back to `AXPress` (position-independent)
- **Text fields**: falls back to `AXFocus` (focusing a text field == clicking it)
- Output includes `"fallback": "AXPress"|"AXFocus"` and `"warning"` when this happens

For elements below the fold, prefer `press` (buttons) or `focus` + `type` (text fields) over `click`.

## Gotchas

- **App-level screenshots capture the wrong window** when an app has multiple windows (e.g. Genesis main + Settings) — apps mark popups/strips as "main". Always pass a window title: `tools control screenshot --app X --window "..."` (peekaboo equivalent: `--window-title`).
- **Browser elements use AXDescription, not AXTitle** — tab text is in `desc`, not `title`. Use `find --text "YouTube"` (searches all attributes) or `find --desc "YouTube"` specifically.
- **Browser tabs are `AXRadioButton`**, not `AXButton` — `find --role AXButton` finds bookmark bar items, `find --role AXRadioButton` finds actual tabs.
- **Two instances of the same app** (e.g. two Brave profiles): name/bundleId resolution fails loud with a candidates list — target one with `--app <pid>` (pids from `tools control apps`). Preflight's `browserTab` carries `pidMatch`/`warning` because AppleScript resolves by name and may answer for the other instance.

## Output

All commands return JSON to stdout: `{"ok": true, ...}` on success, `{"ok": false, "error": "..."}` on failure. Add `--json` to the TS wrapper for raw JSON (compact; add `--pretty` to indent). Safety semantics: `set`/`type` refuse when the target app is not frontmost and hard-verify the field content after typing; `screenshot --window` and `--window` scoping fail loud with a `candidates` list on 0 or 2+ matches; `window` output flags transient popups (`"transient": true`).

## Plan runner (`tools control run`)

ONE plan schema covers sequential automation, timed timelines, and recordings:
- no `atMs` anywhere → sequential (delayMs between steps)
- any step has `atMs` → timeline (steps fire at their offset from start)
- `capture{}` present → whole plan handed to the capture runner (records video; `steps` accepted as alias for its `actions`)

Top-level result: `ok` is true only when EVERY step passed; `failedSteps` carries the count — never trust `ok` alone without it. Run a JSON plan file:

```json
{
  "app": "Genesis",
  "restore": true,
  "delayMs": 300,
  "steps": [
    { "do": "focus" },
    { "do": "press", "id": "settings-open" },
    { "do": "click", "desc": "Account", "role": "button" },
    { "do": "get", "desc": "Account", "role": "button" },
    { "do": "click", "subrole": "close", "window": "Settings" },
    { "do": "window" }
  ]
}
```

```bash
tools control run plan.json          # human output: ok/FAIL per step + total
tools control run plan.json --json   # machine output: full results array
```

Plan fields:
- `app` — default app for all steps (overridable per step with `"app": "..."`)
- `restore` — snapshot mouse + focus before, restore after
- `delayMs` — pause between steps (default 200ms, overridable per step with `"delay": N`)
- `exact` — force strict role/subrole matching for all steps
- `steps[].do` — any ax-tool command name (focus/click/press/set/type/get/find/attrs/actions/perform/window)
- Steps take the same fields as CLI flags: `id`, `role`, `title`, `desc`, `subrole`, `window`, `value`, `text`, `action`

The runner is the declarative equivalent of the shell snapshot/restore pattern but in one call, with timing and error tracking per step.

## Workflow: automate a native app form

```bash
# 1. Discover what's in the app
tools control list --app Genesis --depth 5

# 2. Find the text field (by role if no AXIdentifier)
tools control find --app Genesis --role AXTextField

# 3. Check what you can do with it
tools control actions --app Genesis --id auth-email

# 4. Fill the field
tools control set --app Genesis --id auth-email --value "user@example.com"

# 5. Press the submit button
tools control press --app Genesis --id auth-continue
```

## Workflow: find elements without AXIdentifier

Many apps don't set AXIdentifier on all elements. Use `find` to locate by role/title/value:

```bash
# Find all buttons
tools control find --app Safari --role AXButton

# Find element with specific text
tools control find --app TextEdit --role AXStaticText --value "Untitled"

# Find by title substring
tools control find --app "System Settings" --title "Wi-Fi"
```

## Workflow: get window geometry (for screenshots/crops)

```bash
# Get exact window bounds for screenshot cropping
tools control window --app Genesis
# Returns: x, y, width, height, minimized, fullscreen per window
```

## Recording: `tools control capture` (video + timed actions)

Everything above is single-shot element control. For **multi-frame recording** — capture a transition/animation while firing timed actions, diff-sampled frames, contact sheets, declarative crops, vitrinka publish — use the capture runner:

```bash
tools control capture preflight [--app "<Name>"]   # ALWAYS FIRST when writing a capture plan
tools control capture --help                       # full plan/actions contract
tools control capture plan.json 1>result.json 2>err.log
```

**Read `references/capture.md` before writing any recording plan** — it holds the full recording discipline (duration/fps parsing, capture-target resolution, timing model, crop markers, focus re-assertion, troubleshooting, anti-patterns). `references/peekaboo.md` has the underlying peekaboo flag tables. Recording requires the external `peekaboo` binary (homebrew); element control does not.

Capture plans support three AX action types (same targeting as the CLI):

| Action type | What it does | Needs ax-tool binary? |
|-------------|-------------|----------------|
| `ax-set` | Write a text field value | No (osascript fallback) |
| `ax-press` | Press a button/toggle | No (osascript fallback) |
| `ax-perform` | Any AX action (AXShowMenu, AXRaise, etc.) | Yes (no fallback) |

The binary auto-builds on first `tools control` run. With it, all three use the fast path (~50-200ms); without it, `ax-set`/`ax-press` fall back to osascript (~2-5s) and `ax-perform` errors.

### Plan authoring workflow (element discovery, then recording)

```bash
# 1. Discover elements with ax-tool
tools control list --app Genesis --depth 5           # see all elements
tools control find --app Genesis --role AXButton     # find buttons
tools control find --app Genesis --desc "Settings"   # find by description
tools control actions --app Genesis --id nav-chat    # what actions are available?

# 2. Get window bounds (same CG point system as click coords / relativeTo)
tools control window --app Genesis
# Returns: x, y, width, height — use for crop regions or relativeTo offsets

# 3. Write the plan using discovered identifiers
cat > /tmp/plan.json << 'EOF'
{
  "capture": { "mode": "screen", "screenIndex": 0, "duration": 5,
               "activeFps": 8, "noRemote": true, "captureEngine": "cg" },
  "focus": { "app": "Genesis" },
  "actions": [
    { "atMs": 500,  "do": "ax-set", "axId": "auth-email", "value": "user@test.com", "app": "Genesis" },
    { "atMs": 1500, "do": "ax-press", "axId": "auth-continue", "app": "Genesis" },
    { "atMs": 3000, "do": "ax-perform", "axId": "theme-picker", "action": "AXShowMenu", "app": "Genesis" }
  ]
}
EOF

# 4. Run the capture
tools control capture /tmp/plan.json 1>/tmp/result.json 2>/tmp/capture.err
```

### When to use element commands directly vs the capture runner

| Scenario | Use |
|----------|-----|
| Fill a form, click a button (no recording needed) | `tools control set` / `tools control press` directly |
| Inspect element attributes, discover identifiers | `tools control list` / `find` / `attrs` / `actions` directly |
| Get window bounds for screenshot/crop planning | `tools control window` directly |
| Static click-through sequence with screenshots at each step | `tools control run plan.json` (~100ms/step, native screenshots) |
| Record UI transitions while interacting with native controls | `tools control capture` plan with `ax-set`/`ax-press`/`ax-perform` actions |
| Timed sequence (fill form, wait, press, record the result) | `tools control capture` — timing precision matters |
| Open a dropdown and record the menu appearing | `tools control capture` with `ax-perform` + AXShowMenu |

### `tools control window` as `relativeTo` source

`tools control window` returns window bounds in CG points — the exact coordinate system that `relativeTo` and click coords use. Use it to compute window-relative offsets for capture plans:

```bash
# Get Genesis window position
tools control window --app Genesis --json
# {"windows": [{"x": 49, "y": 810, "width": 900, "height": 452, ...}]}

# Use in a plan with relativeTo (offsets from window top-left):
{ "atMs": 500, "do": "click", "coords": {"x": 100, "y": 200},
  "relativeTo": {"app": "Genesis"} }
```

## App name resolution

`--app` matches in order: exact `localizedName`, case-insensitive name, bundleIdentifier substring. Examples:
- `--app Finder`, `--app Safari`, `--app Genesis`
- `--app "System Settings"` (quote names with spaces)
- `--app com.apple.finder` (bundle ID substring)

## Permissions

Requires Accessibility access for the calling terminal process. Grant in System Settings > Privacy & Security > Accessibility.

## Common AX actions

| Action | Description |
|--------|-------------|
| `AXPress` | Click/activate (use `press` shortcut) |
| `AXRaise` | Bring window to front |
| `AXShowMenu` | Open context/dropdown menu |
| `AXConfirm` | Confirm dialog |
| `AXCancel` | Cancel dialog |
| `AXIncrement` / `AXDecrement` | Stepper/slider |
| `AXPick` | Select menu item |
