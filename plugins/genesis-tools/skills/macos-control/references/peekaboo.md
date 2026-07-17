# Peekaboo reference

> Source: context7 `/openclaw/peekaboo` docs, cross-checked against `peekaboo <cmd> --help` output on the **installed binary, 3.0.0-beta3** (`/opt/homebrew/bin/peekaboo`), 2026-07-15. Every flag/command below is marked `(beta3 ✓)` (confirmed present locally) or `(docs-only, not in beta3)` (context7 describes a newer build). This complements `../SKILL.md` — it does not repeat the capture-review workflow, GIF dead end, drag-select absence, latency/runner-script rules, or other lessons already there.

## Contents

- [Command inventory](#command-inventory)
- [`capture live` — full flag reference](#capture-live--full-flag-reference)
- [`capture video` — ingestion](#capture-video--ingestion)
- [JSON output schema](#json-output-schema)
- [Targeting semantics](#targeting-semantics)
- [The Bridge](#the-bridge)
- [UI automation flags](#ui-automation-flags)
- [`see` — element maps and snapshots](#see--element-maps-and-snapshots)
- [`agent` command](#agent-command)
- [Environment variables](#environment-variables)
- [Performance and caching](#performance-and-caching)
- [Docs vs beta3 discrepancies](#docs-vs-beta3-discrepancies)

## Command inventory

All confirmed `(beta3 ✓)` via `peekaboo --help` unless noted.

| Group | Commands |
|---|---|
| Core | `bridge`, `capture` (`live`, `video`, `watch`=alias for `live`), `clean`, `config`, `daemon`, `image`, `learn`, `list` (`apps`, `windows`, `permissions`, `menubar`, `screens`), `permissions`, `run`, `sleep`, `tools` |
| Interaction | `click`, `drag`, `hotkey`, `move`, `paste`, `press`, `scroll`, `swipe`, `type` |
| System | `app` (`launch`,`quit`,`relaunch`,`hide`,`unhide`,`switch`,`list`), `clipboard` (`get`,`set`,`clear`,`save`,`restore`,`load`), `dialog` (`click`,`dismiss`,`file`,`input`,`list`), `dock` (`hide`,`launch`,`list`,`right-click`,`show`), `menu` (`click`,`click-extra`,`list`,`list-all`), `menubar`, `open`, `space` (`list`,`switch`,`move-window`), `visualizer`, `window` (`close`,`minimize`,`maximize`,`move`,`resize`,`set-bounds`,`focus`,`list`) |
| Vision | `see` |
| AI | `agent` (chat/dry-run/resume/audio) |
| MCP | `mcp serve` |

`peekaboo` alone (no subcommand) is `list apps` — that's the default.

## `capture live` — full flag reference

`(beta3 ✓)` — flags exactly as reported by `peekaboo capture live --help`:

| Flag | Meaning | Default |
|---|---|---|
| `--app <app>` | Target app name, bundle ID, or `PID:12345` | — |
| `--pid <pid>` | Target by process ID | — |
| `--mode <mode>` | `screen`\|`window`\|`frontmost`\|`region` | — |
| `--window-title <t>` | Window with matching title | — |
| `--window-index <n>` | Window index | — |
| `--screen-index <n>` | Screen for `--mode screen` | — |
| `--region <x,y,w,h>` | Region for `--mode region` | — |
| `--capture-focus <mode>` | Window focus behavior on capture | — |
| `--capture-engine <e>` | `auto`\|`classic`\|`cg`\|`modern`\|`sckit` | `auto` |
| `--duration <s>` | Recording length | **60**, max 180 |
| `--idle-fps <n>` | FPS while idle | 2 |
| `--active-fps <n>` | FPS while changing | 8, max 15 |
| `--threshold <pct>` | Change % to keep a frame | 2.5 |
| `--heartbeat-sec <s>` | Heartbeat log interval | 5 |
| `--quiet-ms <ms>` | Calm period before considered idle | 1000 |
| `--max-frames <n>` | Soft kept-frame cap | 800 |
| `--max-mb <n>` | Soft output size cap | — |
| `--resolution-cap <px>` | Cap longest side | 1440 |
| `--diff-strategy <s>` | `fast`\|`quality` | — |
| `--diff-budget-ms <ms>` | Time budget for diffing | — |
| `--path <dir>` | Output directory (override session temp dir) | temp |
| `--autoclean-minutes <n>` | Auto-clean session after N min | 120 |
| `--video-out <path>` | Also emit MP4 with ALL captured frames | — |
| `--highlight-changes` (flag) | Overlay motion boxes on saved frames | off |

**Not in the skill already:** `--capture-engine`, `--diff-strategy`/`--diff-budget-ms`, `--max-mb`, `--heartbeat-sec`, `--quiet-ms`, `--highlight-changes`, `--capture-focus`. Worth reaching for `--capture-engine cg --no-remote` when a capture is flaky from a subprocess/CI context — see [The Bridge](#the-bridge).

`--mode frontmost` genuinely exists as a value (the skill advises avoiding it due to observed crashes/bridge errors — that guidance stands; it isn't contradicted by its presence here).

## `capture video` — ingestion

`(beta3 ✓)`. Ingests any existing video (`.mov`, `.mp4`, screen recordings, simulator recordings) — no live recording involved.

| Flag | Meaning | Default |
|---|---|---|
| `<input>` (positional) | Input video file | required |
| `--sample-fps <n>` | Sample rate | 2 |
| `--every-ms <ms>` | Sample every N ms (alternative to `--sample-fps`) | — |
| `--start-ms <ms>` | Trim start | — |
| `--end-ms <ms>` | Trim end | — |
| `--no-diff` (flag) | Keep ALL sampled frames, skip diff filtering | off |
| `--max-frames`, `--max-mb`, `--resolution-cap`, `--diff-strategy`, `--diff-budget-ms`, `--path`, `--autoclean-minutes`, `--video-out` | same semantics as `capture live` | — |

Two documented usage patterns worth knowing beyond what's in SKILL.md:

```bash
# Re-sample a narrower time window from an existing MP4 without re-diffing
peekaboo capture video /tmp/demo.mov --start-ms 5000 --sample-fps 2 --video-out /tmp/demo-trimmed.mp4

# Keep every frame at a fixed interval (no motion filtering at all)
peekaboo capture video /tmp/demo.mov --every-ms 500 --no-diff
```

A fully static input video reports `framesKept: 1` with a `noMotion` warning rather than erroring — useful to recognize when a diff run "did nothing" on purpose.

## JSON output schema

Top-level envelope (all commands with `--json`):

```json
{
  "success": true,
  "data": { /* command-specific */ },
  "debug_logs": ["[timestamp] LEVEL: message", "..."],
  "error": { "error_code": "...", "message": "...", "recovery_suggestion": "...", "context": {} }
}
```

- `debug_logs` is only populated when `--verbose` (or `PEEKABOO_LOG_LEVEL=debug`) is also active.
- `error` is present only when `success: false`. Example real error code: `PERMISSION_DENIED_SCREEN_RECORDING`.

`capture live`/`capture video` `data` shape (already summarized in `SKILL.md` Step 4 — repeated here for completeness since this is the authoritative shape):

```
data: {
  source, options, scope, diffAlgorithm,
  contactSheet: { path, file, rows, columns, thumbSize, sampledFrameIndexes },
  frames: [{ file, path, index, timestampMs, reason, changePercent, motionBoxes }],
  videoOut,   // present only when --video-out was passed
  stats: { ... }
}
```

`see` output includes `data.snapshot_id` plus an element map (`elements[]` / `uiMap`) — each element has a stable ID (`B1`, `T2`, `elem_NN` style) reusable by `click --on`, `drag --from/--to`, `scroll --on`, `move --id`.

## Targeting semantics

Every interaction command (`click`, `drag`, `hotkey`, `move`, `press`, `scroll`, `swipe`, `type`) shares the same targeting flag set `(beta3 ✓)`:

| Flag | Meaning |
|---|---|
| `--app <name\|bundleID\|PID:n>` | Target application |
| `--pid <pid>` | Target by process ID directly |
| `--window-id <id>` | Target by CoreGraphics window id (from `window list --json`) |
| `--window-title <t>` | Partial-match title |
| `--window-index <n>` | 0-based, frontmost is 0 |
| `--focus-timeout-seconds <s>` / `--focus-retry-count <n>` | Tune the auto-focus-before-interact behavior |
| `--no-auto-focus` (flag) | Disable the automatic focus-before-interaction step |
| `--space-switch` (flag) | Switch to the window's Space if it's elsewhere |
| `--bring-to-current-space` (flag) | Bring the window to the current Space instead of switching to it |

**Multi-display**: `peekaboo list screens --json` returns `screens[]` with `index`, `displayID`, `isPrimary`, `name`, `position {x,y}`, `resolution {width,height}`, `scaleFactor`, `visibleArea`. Verified live on this machine: a 3-display setup reports `position.x`/`.y` as negative for displays above/left of the primary (e.g. `x: -1488, y: 1329` for a secondary 2560×1440 panel) — confirms the SKILL.md note that negative window coordinates are legitimate, not junk data. `scaleFactor: 2` on the built-in Retina display vs `1` on external panels — relevant when comparing `--retina` capture output pixel dimensions.

**Spaces**: `space list`, `space switch --to <n>`, `space move-window --app <name> --to <n> [--follow]`, `space move-window --app <name> --to-current`. ⚠️ `space where-is` is **docs-only** — verified 2026-07-15 on installed beta3: `Unknown subcommand 'where-is'`; the only subcommands are list/switch/move-window. To find which Space a window lives on, use `space list --json` (it includes each Space's windows) instead. Space management uses **private macOS APIs** per Peekaboo's own docs — expect breakage across macOS versions.

**Window management** (`window` subcommands, `(beta3 ✓)`): `close`, `minimize`, `maximize`, `move --x --y`, `resize --width --height`, `set-bounds --x --y --width --height` (position+size in one call), `focus`, `list`. All accept the same `--app`/`--window-id`/`--window-title` targeting. `set-bounds` is the one-shot alternative to separate `move`+`resize` calls when repositioning a window before a region capture.

## The Bridge

Peekaboo routes permission-bound operations (Screen Recording, Accessibility, AppleScript) through whichever GUI host app already holds the needed TCC grants, rather than the CLI process itself needing them. Preference order, confirmed both in docs and by a live `bridge status --verbose` run on this machine:

1. `Peekaboo.app`
2. `Claude.app`
3. `Clawdis.app`
4. Local in-process fallback (needs its own grant, commonly missing)

Live verification output (read-only, no state changed):

```
Selected: remote gui via /Users/Martin/Library/Application Support/Peekaboo/bridge.sock (build 3.9.3)
Candidates:
- .../Peekaboo/bridge.sock — OK (gui, ops: 69/69 enabled, perm: SR=Y AX=Y AS=Y)
- .../Claude/bridge.sock — No such file or directory   (Claude.app not running / no bridge socket)
- .../clawdis/bridge.sock — OK (gui, ops: 57/69 enabled, perm: SR=N AX=Y AS=N)
```

This confirms the SKILL.md troubleshooting section's host-order claim and shows the candidate probe is genuinely a live handshake per socket, not a static guess — a candidate can be "OK" (handshake succeeded) yet report a partial `perm:` grant (here, `clawdis` has Accessibility but not Screen Recording or AppleScript), and a candidate can be entirely absent (no socket file) if that host app isn't running.

Useful bridge/permission commands not in SKILL.md:

```bash
peekaboo bridge status --bridge-socket ~/Library/Application\ Support/clawdis/bridge.sock   # probe one host directly
peekaboo bridge status --verbose --json | jq '.data'                                         # machine-readable probe
peekaboo permissions status                  # --all-sources is docs-only: beta3 rejects it ("Unknown option");
                                             # for per-host TCC state use `bridge status --verbose` (perm: SR/AX flags)
peekaboo permissions request-event-synthesizing --no-remote   # request the Event Synthesizing prompt for the LOCAL process specifically
```

**Bypass trick for flaky subprocess/CI captures** (from `docs/integrations/subprocess.md`): if a capture/see call is unreliable when invoked from a subprocess (rather than an interactive shell), force local execution with the CoreGraphics engine instead of going through the bridge:

```bash
# Before (may silently fail from some subprocess contexts)
peekaboo see --app Safari --json
# After (bypasses Bridge routing entirely)
peekaboo see --app Safari --no-remote --capture-engine cg --json
```

`--bridge-socket <path>` (global flag on every command) overrides host discovery entirely and targets one socket — useful when multiple hosts are running and you need a specific one, not auto-preference order.

## UI automation flags

Beyond the shared targeting table above, each command's distinguishing options `(beta3 ✓, from --help)`:

**`click [query]`** — `--on <id>` / `--id <id>` (alias) target an element from a `see` snapshot; `--coords x,y` for raw coordinates; `--snapshot <id>` pins which snapshot resolves the element (defaults to latest); `--wait-for <ms>` polls for the element to appear; `--double`, `--right` flags.

**`type [text]`** — `--profile human` (default, realistic cadence) vs `--profile linear` (deterministic, honors `--delay`); `--wpm <80-220>` only applies under the human profile; `--delay <ms>` between keystrokes (linear profile); `--tab <n>` presses tab N times instead of typing; `--return`/`--escape`/`--delete`/`--clear` flags; escape sequences `\n \t \b \e \\` are parsed inside the text argument. (SKILL.md's "type ignores --delay under human profile" finding is exactly why the runner script forces `--profile linear`.)

**`hotkey`** — positional or `--keys "cmd,c"` (comma) / `"cmd space"` (space-separated); keys pressed in given order, released in reverse; `--hold-duration <ms>` between press and release. Modifier vocabulary: `cmd, shift, alt/option, ctrl, fn`.

**`press <keys>`** — for non-printing keys/navigation, NOT text (`type` is for text). Vocabulary: navigation (`up down left right home end pageup pagedown`), editing (`delete forward_delete clear`), control (`return enter tab escape space`), function (`f1-f12`), plus `caps_lock`, `help`. Sequences: `peekaboo press tab tab return`. `--count <n>` repeats, `--delay`/`--hold` tune timing (defaults 100ms/50ms).

**`scroll`** — `--direction up|down|left|right`, `--amount <ticks>` (one tick ≈ one wheel notch), `--on <elementId>` scroll target, `--smooth` flag for finer increments, `--delay <ms>` between ticks. Note the semantic inversion in the help text itself: "up = scroll content up (wheel down)".

**`move [coords]`** — positional `x,y` or `--coords`; `--to <text>` / `--id <id>` move to an element (cursor centers on it); `--center` moves to screen center; `--smooth` animates; `--profile human` gives natural eased-arc movement vs `--profile linear`. (SKILL.md notes `move` rejects negative multi-display coordinates while `click --coords` accepts them — confirmed still true against this help text, which doesn't document that asymmetry, i.e. it's an undocumented gotcha worth keeping in SKILL.md, not duplicating here.)

**`drag`** — `--from`/`--to` (element IDs) or `--from-coords`/`--to-coords`, mixable; `--to-app <name>` for drop targets like `Trash`/`Finder`; `--modifiers <mods>` held during drag; `--duration <ms>`, `--steps <n>` (interpolation steps), `--profile linear|human`.

**`swipe`** — same shape as `drag` (`--from`/`--from-coords`/`--to`/`--to-coords`, `--duration`, `--steps`, `--profile`) plus `--right-button` to drag with the right mouse button instead of left. Functionally near-identical to `drag`; the docs frame `drag` as UI-element drag-and-drop and `swipe` as the gesture-oriented sibling, but both accept the same coordinate/element inputs.

## `see` — element maps and snapshots

`(beta3 ✓)`. `peekaboo see --app <name>|menubar|frontmost [--mode screen|window|frontmost] [--window-title <t>] [--window-id <id>] [--path <png>] [--annotate] [--menubar] [--capture-engine <e>] [--screen-index <n>] [--analyze <prompt>] [--timeout-seconds <s>] [--no-web-focus]`.

- `--annotate` overlays interaction markers on a saved screenshot (SKILL.md already covers this being near-useless on browser web content vs native apps).
- `--menubar` (flag) captures menu bar popovers via window-list + OCR — distinct from `--app menubar`.
- `--analyze <prompt>` sends the captured content straight to the configured AI provider; bumps the default timeout from 20s to 60s.
- `--no-web-focus` skips the fallback that tries to focus a web content area when no native text fields are detected — useful when that fallback is stealing focus from where you actually want it.
- Snapshot IDs returned in `data.snapshot_id` are reusable across subsequent `click --snapshot`, `drag --snapshot`, etc. — this is what lets multi-step automation stay pinned to one UI state even if the screen changes slightly between calls (see `clean --snapshot <id>` to evict one explicitly).

## `agent` command

`(beta3 ✓)`. `peekaboo agent "<natural language task>" [--model gpt-5.1|claude-opus-4-5|gemini-3-flash] [--max-steps <n>] [--dry-run] [--resume | --resume-session <id>] [--audio | --audio-file <path>] [--realtime] [--chat] [--queue-mode one-at-a-time|all] [--no-cache] [--list-sessions] [-q/--quiet] [--json]`.

Model allow-list on this beta3 build is exactly `gpt-5.1`, `claude-opus-4-5`, `gemini-3-flash` — passing anything else errors. `--dry-run` plans steps without executing any tool calls (safe to run to preview what the agent would do). `--resume` continues the most recent session without retyping the task; `--list-sessions --json` enumerates prior sessions.

## Environment variables

Configuration precedence (highest to lowest, per `config --help`): CLI args → env vars → credentials file (`~/.peekaboo/credentials`) → config file (`~/.peekaboo/config.json`, JSONC with `${VAR}` expansion) → built-in defaults.

| Variable | Effect |
|---|---|
| `PEEKABOO_AI_PROVIDERS` | e.g. `"anthropic/claude-opus-4-8"` or comma-separated fallback chain; feeds `agent`/`--analyze` |
| `PEEKABOO_LOG_LEVEL` | `trace\|verbose\|debug\|info\|warning\|error\|critical` |
| `PEEKABOO_LOG_FILE` | Redirect logs to a file path |
| `PEEKABOO_DISABLE_TOOLS` | Comma list, e.g. `"shell,menu_click"` — additive with config's `tools.deny` |
| `PEEKABOO_ALLOW_TOOLS` | Comma list — highest-precedence allow-list, restricts exposure to only these |
| `PEEKABOO_VISUAL_FEEDBACK` | `false` disables all visualizer overlays |
| `PEEKABOO_VISUAL_SCREENSHOTS` | `false` disables just the screenshot-flash overlay |
| `PEEKABOO_VISUALIZER_STDOUT` | `true` forces visualizer client logs to stderr/stdout |
| `PEEKABOO_VISUALIZER_STORAGE` | Override the shared visualizer events directory |
| `PEEKABOO_VISUALIZER_APP_GROUP` | Resolve storage inside a specific App Group container |
| `PEEKABOO_VISUALIZER_DISABLE_CLEANUP` | `true` keeps JSON envelopes for forensic debugging (off by default) |
| `PEEKABOO_VISUALIZER_FORCE_APP` | `true` pretends the CLI runs inside the mac app bundle — **this fires on every command on this machine** (`[Visualizer][INFO] Visualizer client forcing mac-app context via PEEKABOO_VISUALIZER_FORCE_APP` printed on every `--help`/`list`/`bridge status` call observed during this research), confirming it's set in this environment already |
| `PEEKABOO_BIN` | Override which built CLI binary a test harness invokes (dev/testing use) |

Config-file equivalent of `PEEKABOO_ALLOW_TOOLS`/`PEEKABOO_DISABLE_TOOLS`: `{"tools": {"allow": [...], "deny": [...]}}` in `~/.peekaboo/config.json`.

## Performance and caching

- **`peekaboo clean`** prunes snapshot/session caches: `--older-than <duration>` (e.g. `1m`), `--snapshot <id>` (one specific snapshot), `--all-snapshots`, `--dry-run` to preview without deleting. Capture sessions already auto-clean per `--autoclean-minutes` (default 120) — `clean` is for manual/forced eviction, e.g. reclaiming disk after a long blip-hunting session with many `--video-out` files.
- **`see` results cache ~1.5s** (already in SKILL.md) — rapid repeat `see` calls in a tight loop return stale data; space them out or force a fresh snapshot.
- **`--capture-engine`** (`auto|classic|cg|modern|sckit`, available on `capture live`, `image`, `see`) lets you pin the underlying capture backend. `cg` (CoreGraphics) is the one to reach for when bypassing the Bridge (`--no-remote --capture-engine cg`) for subprocess reliability — see [The Bridge](#the-bridge).
- **Swift build caching** (`COMPILATION_CACHE_ENABLE_CACHING=YES`) is a peekaboo-development-only concern (compiling the CLI itself from source), not relevant to consuming the installed binary — noted here only so it isn't mistaken for a runtime perf knob.

## Docs vs beta3 discrepancies

- **`capture action`** (record around a child command with pre/post-roll) — documented in context7 sources, confirmed **absent** from beta3: `peekaboo capture action --help` falls through to the parent `capture` help with no `action` subcommand listed. SKILL.md's runner script (`scripts/capture-with-actions.ts`) is the beta3-compatible substitute and should keep being used.
- Everything else pulled from context7 in this pass (`capture live`/`capture video` flags, all UI automation commands, `see`, `agent`, `window`/`space`/`dialog`/`menu`/`dock`/`app`/`clipboard`, bridge/permissions commands, env vars) was independently confirmed present via local `--help` output — no other gaps found in this beta.
