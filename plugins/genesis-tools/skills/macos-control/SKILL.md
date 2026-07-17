---
name: macos-control
description: Control macOS native app UI via Accessibility API. Use when automating native apps — clicking buttons, filling forms, reading element state, finding elements, getting window bounds. Triggers on "click button in app", "fill form in native app", "automate macOS app", "list UI elements", "find button", "read text field value", "get window position", "what actions can I perform", "interact with native app".
---

# `tools ax` — macOS Accessibility API Automation

Fast native CLI for reading and controlling macOS app UI via the Accessibility API. 10-30x faster than osascript (~66ms get, ~130ms list, ~170ms press vs 2-5s).

## Commands

### Discovery (find elements you want to interact with)

```bash
tools ax list --app <name> [--depth N]          # Flat list of all elements (max 2000)
tools ax tree --app <name> [--depth N]          # Hierarchical nested tree (shows parent-child)
tools ax find --app <name> --role button        # Fuzzy: "button" matches AXButton
tools ax find --app <name> --title "Save"       # Find by title (substring, case-insensitive)
tools ax find --app <name> --text "YouTube"     # Search title+desc+value at once (OR)
tools ax find --app <name> --desc "Chat"        # Find by description (many SwiftUI elements use this)
tools ax find --app <name> --subrole close      # Fuzzy: "close" matches AXCloseButton
tools ax find --app <name> --role button --title "Email" --exact  # --exact forces strict role match
```

Role/subrole matching is fuzzy by default: `button` finds `AXButton`, `radio` finds `AXRadioButton`, `close` finds `AXCloseButton`. Add `--exact` when you need strict matching.

### Inspection (read element details)

```bash
tools ax get --app <name> --id <axId>           # Read role/title/value/description
tools ax attrs --app <name> --id <axId>         # ALL attributes with decoded values
tools ax actions --app <name> --id <axId>       # Available AX actions (AXPress, AXShowMenu, etc.)
tools ax window --app <name>                    # Window bounds: x,y,width,height + minimized/fullscreen
```

### Interaction (modify elements)

```bash
tools ax set --app <name> <target> --value "text"                  # Set text field value (AXValue)
tools ax press --app <name> <target>                               # Press (AXPress — AX action path)
tools ax click --app <name> <target>                               # CGEvent click at element center
tools ax perform --app <name> <target> --action AXShowMenu         # Any AX action
tools ax focus --app <name> [<target>]                             # Activate app + focus element
tools ax type --app <name> --text "hello" [<target>]               # Type keystrokes via CGEvent
```

### Targeting (`<target>`)

All interaction/inspection commands accept `--id <axId>` OR any combination of `--role`/`--title`/`--desc`/`--subrole` (first match). Elements without AXIdentifier (browser tabs, toolbar buttons, window close buttons) are fully interactable:

```bash
# By AXIdentifier (native apps with .accessibilityIdentifier)
tools ax press --app Genesis --id nav-chat

# By role + description (browser elements — no id needed)
tools ax click --app "Brave Browser" --desc "Reload" --role AXButton
tools ax click --app "Brave Browser" --desc "YouTube" --role AXRadioButton

# By description alone (Genesis settings tabs sharing the same id)
tools ax press --app Genesis --desc "Account" --role AXButton

# By subrole (window close/minimize/fullscreen buttons have no id or desc)
tools ax click --app Genesis --subrole AXCloseButton --window Settings

# --window scopes search to a specific window (by title substring)
tools ax click --app Genesis --subrole AXMinimizeButton --window Genesis
```

## `click` vs `press` vs `set`

| Command | Mechanism | When to use |
|---------|-----------|-------------|
| `press` | AX action (AXPress) | Buttons/toggles in native apps — position-independent, works on obscured or scrolled-away elements |
| `click` | CGEvent at element center | Real mouse click — exercises hit testing, works on web content, triggers hover/focus |
| `set` | AXValue write | Text fields — instant, no typing animation |
| `type` | CGEvent keystrokes | When you need real typing (autocomplete, validation, non-AX inputs) |
| `focus` | NSRunningApplication.activate + AXFocused | Bring app/element to front before typing |

### `click` scroll-safety

`click` checks if the element center is within any visible window bounds. If the element is scrolled out of view (e.g. below the fold in a scroll area), it falls back automatically:
- **Buttons**: falls back to `AXPress` (position-independent)
- **Text fields**: falls back to `AXFocus` (focusing a text field == clicking it)
- Output includes `"fallback": "AXPress"|"AXFocus"` and `"warning"` when this happens

For elements below the fold, prefer `press` (buttons) or `focus` + `type` (text fields) over `click`.

## Gotchas

- **`peekaboo image --app X` captures the wrong window** when an app has multiple windows (e.g. Genesis main + Settings). Always use `peekaboo image --app X --window-title "..."` to target the correct one.
- **Browser elements use AXDescription, not AXTitle** — tab text is in `desc`, not `title`. Use `find --text "YouTube"` (searches all attributes) or `find --desc "YouTube"` specifically.
- **Browser tabs are `AXRadioButton`**, not `AXButton` — `find --role AXButton` finds bookmark bar items, `find --role AXRadioButton` finds actual tabs.

## Output

All commands return JSON to stdout: `{"ok": true, ...}` on success, `{"ok": false, "error": "..."}` on failure. Add `--json` to the TS wrapper for raw JSON (default is human-friendly formatting).

## Plan runner (`tools ax run`)

Run a JSON plan file — sequential ax commands with automatic snapshot/restore:

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
tools ax run plan.json          # human output: ok/FAIL per step + total
tools ax run plan.json --json   # machine output: full results array
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
tools ax list --app Genesis --depth 5

# 2. Find the text field (by role if no AXIdentifier)
tools ax find --app Genesis --role AXTextField

# 3. Check what you can do with it
tools ax actions --app Genesis --id auth-email

# 4. Fill the field
tools ax set --app Genesis --id auth-email --value "user@example.com"

# 5. Press the submit button
tools ax press --app Genesis --id auth-continue
```

## Workflow: find elements without AXIdentifier

Many apps don't set AXIdentifier on all elements. Use `find` to locate by role/title/value:

```bash
# Find all buttons
tools ax find --app Safari --role AXButton

# Find element with specific text
tools ax find --app TextEdit --role AXStaticText --value "Untitled"

# Find by title substring
tools ax find --app "System Settings" --title "Wi-Fi"
```

## Workflow: get window geometry (for screen-capture)

```bash
# Get exact window bounds for screenshot cropping
tools ax window --app Genesis
# Returns: x, y, width, height, minimized, fullscreen per window
```

## Integration with screen-capture (capture-with-actions.ts)

The screen-capture skill's `capture-with-actions.ts` supports three AX action types in recording plans:

| Action type | What it does | Needs ax-tool? |
|-------------|-------------|----------------|
| `ax-set` | Write a text field value | No (osascript fallback) |
| `ax-press` | Press a button/toggle | No (osascript fallback) |
| `ax-perform` | Any AX action (AXShowMenu, AXRaise, etc.) | Yes (no fallback) |

The runner finds ax-tool at `~/Tresors/Projects/GenesisTools/native/ax-tool/.build/release/ax-tool`. When built, all three action types use the fast path (~50-200ms). Without it, `ax-set`/`ax-press` fall back to osascript (~2-5s); `ax-perform` errors.

### Plan authoring workflow (ax-tool for discovery, capture-with-actions for recording)

```bash
# 1. Discover elements with ax-tool
tools ax list --app Genesis --depth 5           # see all elements
tools ax find --app Genesis --role AXButton     # find buttons
tools ax find --app Genesis --desc "Settings"   # find by description
tools ax actions --app Genesis --id nav-chat    # what actions are available?

# 2. Get window bounds (same CG point system as click coords / relativeTo)
tools ax window --app Genesis
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
bun ~/.claude/skills/screen-capture/scripts/capture-with-actions.ts /tmp/plan.json \
  1>/tmp/result.json 2>/tmp/capture.err
```

### When to use ax-tool directly vs through capture-with-actions

| Scenario | Use |
|----------|-----|
| Fill a form, click a button (no recording needed) | `tools ax set` / `tools ax press` directly |
| Inspect element attributes, discover identifiers | `tools ax list` / `find` / `attrs` / `actions` directly |
| Get window bounds for screenshot/crop planning | `tools ax window` directly |
| Record UI transitions while interacting with native controls | `capture-with-actions.ts` plan with `ax-set`/`ax-press`/`ax-perform` actions |
| Timed sequence (fill form, wait, press, capture the result) | `capture-with-actions.ts` — timing precision matters |
| Open a dropdown and capture the menu appearing | `capture-with-actions.ts` with `ax-perform` + AXShowMenu |

### `tools ax window` as `relativeTo` source

`tools ax window` returns window bounds in CG points — the exact coordinate system that `relativeTo` and click coords use. Use it to compute window-relative offsets for capture plans:

```bash
# Get Genesis window position
tools ax window --app Genesis --json
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
