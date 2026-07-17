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

## Commands (17)

| Group | Commands |
|-------|----------|
| Discovery | `list`, `tree`, `find`, `window`, `attrs`, `actions`, `preflight` |
| Inspection | `get` |
| Interaction | `press`, `perform`, `set`, `click`, `focus`, `type`, `hotkey`, `screenshot` |
| State | `snapshot`, `restore` |

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
