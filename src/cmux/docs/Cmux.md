# cmux Reference for `tools cmux`

Comprehensive reference for every cmux CLI command and JSON-RPC method this tool relies on. Verified against **cmux 0.63.2 (build 79, commit `179b16ce6`)** on macOS.

> **Naming.** "cmux" here means [github.com/manaflow-ai/cmux](https://github.com/manaflow-ai/cmux), the AI-native macOS terminal multiplexer (NOT `soheilhy/cmux`, NOT `coder/cmux`).

---

## Table of contents

1. [Architecture in 60 seconds](#architecture-in-60-seconds)
2. [Two ways in: CLI vs raw socket](#two-ways-in-cli-vs-raw-socket)
3. [Refs, IDs, indices](#refs-ids-indices)
4. [Discovery and identification](#discovery-and-identification)
5. [Windows](#windows)
6. [Workspaces](#workspaces)
7. [Panes](#panes)
8. [Surfaces (tabs)](#surfaces-tabs)
9. [Geometry](#geometry)
10. [Sending input](#sending-input)
11. [Browser surfaces](#browser-surfaces)
12. [Sidebar status / progress / log / notifications](#sidebar-status--progress--log--notifications)
13. [Known sharp edges & cmux 0.63.2 quirks](#known-sharp-edges--cmux-0632-quirks)
14. [What `tools cmux profiles ...` actually does](#what-tools-cmux-profiles--actually-does)

---

## Architecture in 60 seconds

```text
window  ─┬─ workspace ─┬─ pane ─┬─ surface (terminal | browser)
         │             │        └─ surface
         │             └─ pane ─── surface
         └─ workspace ─── pane ─── surface
```

- **window** — a macOS window. Contains 1+ workspaces (tabs along the top).
- **workspace** — what the user sees as a "tab" / "project". Contains a 2-D layout of panes.
- **pane** — a rectangular slot in the workspace. Created by splitting another pane.
- **surface** — the contents of a pane. A pane can hold multiple surfaces; only one is active at a time (think tmux window-tabs inside a single split). Surfaces come in two flavors: `terminal` (a pty + shell) or `browser` (an embedded WebKit view).

Every pane has *current* `columns × rows` and a `pixel_frame` only when its workspace is the rendered one. Background workspaces report stale or zeroed geometry.

---

## Two ways in: CLI vs raw socket

Both speak the same JSON-RPC protocol; the CLI is just a thin wrapper.

| Path | Pro | Con |
|------|-----|-----|
| `cmux <command>` (CLI) | Quoting works the way you'd expect; output is human-readable. | The CLI's `--json` flag is sometimes a passthrough, sometimes filters fields, sometimes returns plain text (`OK <ref>`). Inconsistent. |
| Unix socket at `/Users/<you>/Library/Application Support/cmux/cmux.sock` | Raw JSON, all fields preserved (incl. geometry). | Have to write a tiny client. |

**This tool uses the CLI for mutating verbs** (`new-split`, `new-surface`, `rename-tab`, `select-workspace`, `resize-pane`, `send`, `close-workspace`, `rename-workspace`) **and the raw socket for read-time fields** that the CLI strips (`pane.list` geometry, `browser.url.get`, `window.list` refs). See `src/cmux/lib/cli.ts` and `src/cmux/lib/socket.ts`.

### Resolving the socket path

The path used to be `/tmp/cmux.sock`; in current builds it lives in your Library. Always resolve dynamically:

```bash
cmux identify --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["socket_path"])'
```

The lib does this once and caches the result (`getSocketPath()` in `socket.ts`).

### Raw RPC envelope

```json
// request
{"id":"x","method":"<method>","params":{ ... }}\n

// success
{"id":"x","ok":true,"result":{ ... }}

// failure
{"id":"x","ok":false,"error":{"code":"<code>","message":"<msg>"}}
```

Always send a trailing `\n`. The server replies with one line. `capabilities` returns the full method allow-list (159 methods on 0.63.2).

---

## Refs, IDs, indices

cmux exposes three kinds of handles:

| Handle | Format | Stable across | Use when |
|--------|--------|---------------|----------|
| **ref** | `window:1`, `workspace:2`, `pane:3`, `surface:4`, `tab:4` | Single cmux session | Day-to-day; what the CLI prints by default. |
| **UUID id** | `6DC71832-2DC6-42F0-8D21-761B87EF5726` | Persists across restarts | Long-term references (e.g. session files). Pass with `--id-format uuids` or use `*_id` fields. |
| **index** | `0`, `1`, `2` | Within parent | Selecting nth tab in a pane. Refs preferred. |

Tab refs (`tab:N`) are the same numeric id as the surface they wrap; both refer to the same row in the data model. `tab-action` accepts either.

**Refs reset every cmux relaunch.** Profile JSON stores titles + structure, never raw refs, for that reason.

---

## Discovery and identification

### `cmux identify [--json]`

Returns the calling shell's place in the cmux tree, plus the focused surface and the socket path.

```jsonc
{
  "socket_path": "/Users/Martin/Library/Application Support/cmux/cmux.sock",
  "caller": {
    "window_ref": "window:1",
    "workspace_ref": "workspace:2",
    "pane_ref": "pane:5",
    "surface_ref": "surface:16",
    "tab_ref": "tab:16",
    "is_browser_surface": false,
    "surface_type": "terminal"
  },
  "focused": { /* same shape — what's currently visible */ }
}
```

`identify` is the first call this tool makes (`getSocketPath()` reads `socket_path`).

### `cmux capabilities`

Lists every JSON-RPC method the daemon understands. Useful for spelunking — `pane.geometry`, `workspace.layout`, etc. are NOT in the list, so don't bother asking for them.

### `cmux ping` / `cmux version`

`ping` returns `pong`; `version` prints `cmux X.Y.Z (build N) [<sha>]` as plain text. The tool parses `cmux (\S+)` for the semver.

---

## Windows

A cmux process can have multiple top-level macOS windows. `tools cmux profiles` treats them as another nesting level.

| Operation | CLI | Raw RPC |
|-----------|-----|---------|
| List windows | `cmux list-windows` (lacks `ref`) | `window.list` (has `ref` & `selected_workspace_ref`) |
| Current window | `cmux current-window` | `window.current` |
| New window | `cmux new-window` | `window.create` |
| Focus window | `cmux focus-window --window <ref>` | `window.focus` |
| Close window | `cmux close-window --window <ref>` | `window.close` |
| Move workspace to window | `cmux move-workspace-to-window --workspace <ref> --window <ref>` | `workspace.move_to_window` |

**Important.** `cmux --json list-windows` outputs an array but **does not include `ref`** for each entry — only `id`, `index`, `selected_workspace_id`, `key`, `workspace_count`, `visible`. Use raw `window.list` to get refs.

```bash
# raw, with refs
python3 -c 'import socket,json
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.connect("/Users/Martin/Library/Application Support/cmux/cmux.sock")
s.send((json.dumps({"id":"x","method":"window.list","params":{}})+"\n").encode())
import select; buf=b""
while select.select([s],[],[],0.5)[0]:
    c=s.recv(8192); buf+=c
    if not c: break
print(json.loads(buf.decode())["result"]["windows"][0])'
```

---

## Workspaces

| Operation | CLI | Raw RPC | Notes |
|-----------|-----|---------|-------|
| List in current window | `cmux list-workspaces` | `workspace.list` | Without `--params.window`, returns only the focused window's workspaces. |
| List in specific window | n/a | `workspace.list {"window":"window:N"}` | Use this for multi-window snapshots. |
| New | `cmux new-workspace [--name X] [--cwd PATH] [--command CMD]` returns `OK <ref>` (plain text) | `workspace.create` returns `{workspace_ref, workspace_id, window_ref, window_id}` | The `name` arg is **best-effort** — cmux frequently overrides it with an auto-generated `user@host:cwd` title. Always follow up with `rename-workspace`. |
| Rename | `cmux rename-workspace [--workspace <ref>] "<title>"` | `workspace.rename` | Sticks. Use this. |
| Select (focus) | `cmux select-workspace --workspace <ref>` | `workspace.select` | **Steals user focus**. The 400 ms after the call is when geometry settles. |
| Reorder | `cmux reorder-workspace --workspace <ref> (--index N \| --before <ref> \| --after <ref>)` | `workspace.reorder` | |
| Close | `cmux close-workspace --workspace <ref>` | `workspace.close` | Surfaces inside die with the workspace. |
| Action (pin / unpin / etc.) | `cmux workspace-action --action <name> [--workspace <ref>]` | `workspace.action` | The set of valid actions is undocumented; `rename` is the only one we use. |

### Per-workspace fields worth knowing

A `workspace.list` entry contains:

```jsonc
{
  "ref": "workspace:1",
  "id": "92F762D5-...",
  "index": 0,
  "title": "reservine",
  "selected": false,           // is this the focused workspace?
  "pinned": false,
  "current_directory": "/Users/Martin/Tresors/Projects/ReservineBack",
  "description": null,
  "listening_ports": [],
  "remote": { /* SSH state */ }
}
```

`current_directory` is the workspace's "default" cwd — the cwd new shells in this workspace inherit. `tools cmux profiles save` records it on every workspace. (Per-pane cwds for *existing* shells are derived from tab titles instead — see below.)

---

## Panes

A pane is a rectangle in the workspace. cmux manages them in a binary split tree internally; the CLI exposes the leaves.

| Operation | CLI | Raw RPC |
|-----------|-----|---------|
| List panes in workspace | `cmux list-panes --workspace <ref>` | `pane.list {"workspace":"<ref>"}` |
| New split (creates a new pane next to the target) | `cmux new-split <left\|right\|up\|down> [--workspace <ref>] [--surface <ref>]` returns `{pane_ref, surface_ref, type, workspace_ref, window_ref}` | `surface.split` (see [the BIG GOTCHA](#the-big-gotcha-surfacesplit-ignores-its-surface-param)) |
| Focus pane | `cmux focus-pane --pane <ref>` | `pane.focus` |
| Resize pane | `cmux resize-pane --pane <ref> -L\|-R\|-U\|-D --amount <n>` | `pane.resize` |
| Swap panes | `cmux swap-pane --pane <ref> --target-pane <ref>` | `pane.swap` |
| New empty pane | `cmux new-pane [--type terminal\|browser] [--direction ...] [--url ...]` | `pane.create` |
| Break pane out to its own window | (no CLI) | `pane.break` |
| Join two panes | (no CLI) | `pane.join` |

### `cmux list-panes --workspace <ref>` output (CLI, plain mode)

```text
  pane:23  [1 surface]
* pane:35  [1 surface]  [focused]
  pane:36  [3 surfaces]
  pane:37  [1 surface]  [focused]
```

### `pane.list` raw RPC output (the shape this tool relies on)

```jsonc
{
  "workspace_ref": "workspace:2",
  "window_ref": "window:1",
  "container_frame": { "width": 3193.097, "height": 1378 },
  "panes": [
    {
      "ref": "pane:4",
      "id": "...",
      "index": 0,
      "focused": false,
      "surface_count": 1,
      "surface_refs": ["surface:14"],
      "selected_surface_ref": "surface:14",

      // Geometry — only present on cmux 0.63.0+ (verified 0.63.2)
      "columns": 199,
      "rows": 38,
      "cell_width_px": 8,
      "cell_height_px": 17,
      "pixel_frame": {
        "x": 246.902, "y": 32, "width": 1596.548, "height": 689
      }
    }
    // ...
  ]
}
```

`columns × rows` is what `stty size` would report inside the shell. `pixel_frame` is in macOS points, including the sidebar offset (so `x: 247` ≈ sidebar width + 0).

### Resize semantics

`cmux resize-pane --pane <ref> -R --amount 5` moves the **right boundary** of the pane right by 5 cells (i.e. pane gains 5 columns; the right neighbour loses 5). Dual for `-L/-U/-D`. If a pane has no neighbour in that direction the call fails with:

```text
invalid_state: No vertical split ancestor for pane
```

`tools cmux profiles restore` swallows these failures and logs a warning rather than aborting — they happen when the converge loop overshoots and tries to push past a cmux constraint.

---

## Surfaces (tabs)

Surfaces are tabs inside a pane. Each pane has 1+ surfaces; clicking a tab makes that surface the visible one.

| Operation | CLI | Raw RPC |
|-----------|-----|---------|
| List surfaces in a pane | `cmux list-pane-surfaces --workspace <ref> --pane <ref>` | `pane.surfaces` |
| List ALL surfaces in workspace | (no CLI) | `surface.list {"workspace":"<ref>"}` |
| New surface in existing pane | `cmux new-surface --pane <ref> --workspace <ref> [--type terminal\|browser] [--url URL]` returns `{pane_ref, surface_ref, type, ...}` | `surface.create` |
| Close (kill) a surface | `cmux close-surface --surface <ref>` | `surface.close` |
| Rename a tab | `cmux rename-tab [--workspace <ref>] [--surface <ref>] "<title>"` | `tab.action {"action":"rename","title":"..."}` |
| Move surface across panes | `cmux move-surface --surface <ref> [--pane <ref>] [--workspace <ref>] [--window <ref>] [--before <ref>] [--after <ref>] [--index N] [--focus true\|false]` | `surface.move` |
| Reorder tabs in same pane | `cmux reorder-surface --surface <ref> (--index N \| --before <ref> \| --after <ref>)` | `surface.reorder` |
| Refresh (reload everything) | `cmux refresh-surfaces` | `surface.refresh` |
| Surface health check | `cmux surface-health --workspace <ref>` | `surface.health` |
| Drag-target → split | `cmux drag-surface-to-split --surface <ref> <left\|right\|up\|down>` | `surface.drag_to_split` |

### Surface metadata returned by `list-pane-surfaces`

```jsonc
[
  { "ref": "surface:1",  "type": "terminal", "title": "✳ templates-todo",                       "index": 0, "selected": false },
  { "ref": "surface:3",  "type": "terminal", "title": "Martin@MacBook-Pro:~/Tresors/Projects/X", "index": 1, "selected": false },
  { "ref": "surface:12", "type": "terminal", "title": "tools claude usage",                     "index": 2, "selected": true  }
]
```

`index` is **per-pane** (this is what `surface.list` calls `index_in_pane`). `selected` means "active tab in this pane". The CLI uses the short names; the raw socket method `surface.list` uses the long names. Don't mix them.

### How cmux titles surfaces

cmux derives a default tab title from whatever is running:

| Running | Example title |
|---------|---------------|
| Idle shell (zsh) | `Martin@MacBook-Pro:~/Tresors/Projects/Foo` (OSC-7 + OSC-1337 derived) |
| `cd` to a long path, then idle | `…/Projects/Foo/sub/dir` |
| `claude` working | `✳ <session-name>` |
| `claude` idle | `⠐ <session-name>` |
| Shell command | the command line itself |

`shell-probe.cwdFromTitle()` parses the first two patterns to recover a cwd without intrusively running `pwd` in each shell.

---

## Geometry

cmux 0.63.0 added `pixel_frame`, `columns`, `rows`, `cell_*_px`, and a top-level `container_frame` to `pane.list`. These are what enable exact 1-to-1 layout duplication. They're stripped from the CLI's `--json` output but present in the raw socket response.

To verify on your install:

```bash
echo "cmux $(cmux --version)"
python3 -c 'import socket,json
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.connect("/Users/Martin/Library/Application Support/cmux/cmux.sock")
s.send((json.dumps({"id":"x","method":"pane.list","params":{"workspace":"workspace:1"}})+"\n").encode())
import select; buf=b""
while select.select([s],[],[],0.5)[0]:
    c=s.recv(65536); buf+=c
    if not c: break
data=json.loads(buf.decode())
print("container:", data["result"]["container_frame"])
print("first pane has geometry:", any("pixel_frame" in p for p in data["result"]["panes"]))'
```

---

## Sending input

| Operation | CLI | Raw RPC |
|-----------|-----|---------|
| Send literal text to a surface | `cmux send [--workspace <ref>] [--surface <ref>] "<text>"` | `surface.send_text` |
| Send a key | `cmux send-key [--workspace <ref>] [--surface <ref>] <key>` | `surface.send_key` |
| Capture buffer | `cmux capture-pane [--workspace <ref>] [--surface <ref>] [--scrollback] [--lines N]` | `surface.read_text` |
| Read whole screen | `cmux read-screen [--workspace <ref>] [--surface <ref>] [--scrollback] [--lines N]` | (alias of read_text) |
| Trigger a flash | `cmux trigger-flash [--workspace <ref>] [--surface <ref>]` | `surface.trigger_flash` |

Key names accepted by `send-key`: `enter`, `tab`, `escape`, `up`/`down`/`left`/`right`, `ctrl-c`, `ctrl-d`, `pgup`, `pgdn`, etc.

`tools cmux profiles restore` uses `cmux send` for two purposes:

1. `send "cd <cwd>\n"` — actually executes (newline included).
2. `send "<command>"` — without the newline, so the captured shell command sits at the prompt and waits for the user to confirm with Enter.

---

## Browser surfaces

Browser surfaces are full WKWebViews. `tools cmux profiles save` captures their URL via the JSON-RPC `browser.url.get` call.

| Verb | CLI | RPC |
|------|-----|-----|
| Open browser surface | `cmux browser open <url>` (opens new split) | `browser.open_split` |
| Get URL | (no CLI on 0.63.2) | `browser.url.get {"surface":"<ref>"}` |
| Navigate | `cmux browser <ref> goto <url>` | `browser.navigate` |
| Reload | `cmux browser <ref> reload` | `browser.reload` |
| Back / forward | `cmux browser <ref> back \| forward` | `browser.back` / `browser.forward` |
| Snapshot DOM | `cmux browser <ref> snapshot --interactive` | `browser.snapshot` |
| Click / fill / type | `cmux browser <ref> click <eN>` etc. | `browser.click` / `browser.fill` / `browser.type` |
| Save / load full state | `cmux browser <ref> state save \| load <path>` | `browser.state.save` / `browser.state.load` |

cmux's full Playwright-equivalent API has ~85 methods under the `browser.*` namespace. `tools cmux profiles` only needs `browser.url.get`; everything else is left to `tools cmux browser` (future tool) or the user's other automation.

---

## Sidebar status / progress / log / notifications

Not used by the profile tool, but documented for completeness. These commands write to the cmux sidebar without stealing focus.

```bash
cmux set-status <key> <value> [--icon <name>] [--color <#hex>]
cmux clear-status <key>
cmux list-status
cmux set-progress <0.0..1.0> [--label <text>]
cmux clear-progress
cmux log [--level info|success|warn|error] [--source <name>] -- <message>
cmux clear-log
cmux list-log [--limit N]
cmux sidebar-state
cmux notify --title <text> [--subtitle <text>] [--body <text>]
cmux list-notifications
cmux clear-notifications
```

Icon names are documented at `cmux help set-status`. Some popular ones: `hammer`, `clock`, `checkmark`, `xmark`, `bolt`, `sparkles`, `star`.

---

## Known sharp edges & cmux 0.63.2 quirks

These bit me during implementation. Don't trust the docs blindly; check.

### The BIG GOTCHA: `surface.split`, `surface.create`, and `pane.list` all ignore their explicit params

Three V1-routed methods fall back to `tabManager.selectedTabId` instead of using the explicit ref(s) on the request:

```json
{"method":"surface.split","params":{"direction":"down","surface":"surface:47","workspace":"workspace:9"}}
// Splits the FOCUSED pane, not the pane containing surface:47.

{"method":"surface.create","params":{"workspace":"workspace:17","pane":"pane:54","type":"terminal"}}
// Creates the surface in the FOCUSED pane (returns pane_ref of the focused pane,
// not pane:54). Effect for restore: when a saved layout has multi-tab panes, every
// extra tab piles up in the anchor pane instead of going to its target.

{"method":"pane.list","params":{"workspace":"workspace:1"}}
// Returns the FOCUSED workspace's panes; response even echoes workspace_ref of the
// focused workspace, not the requested one.
```

For all three, the CLI counterparts work correctly — they route through V2 and honor the explicit params. So this tool uses:
- `cmux new-split <dir> --surface <ref> --workspace <ref>` instead of raw `surface.split`
- `cmux new-surface --pane <ref> --workspace <ref>` instead of raw `surface.create`
- For `pane.list` there's no V2 CLI alternative that returns geometry; we work around by `cmux select-workspace`-ing to the target before reading (causes focus flicker — same reason save can't run in the background).

Filed upstream as [manaflow-ai/cmux#3189](https://github.com/manaflow-ai/cmux/issues/3189).

### `cmux new-workspace`'s `--name` is best-effort

cmux often replaces it with `Martin@MacBook-Pro:~/path/cwd`. Always follow up:

```bash
cmux new-workspace --name "my-name"
# → "OK workspace:N"
cmux rename-workspace --workspace workspace:N "my-name"   # this sticks
```

### `cmux --json` is not consistent

| Command | `--json` behavior |
|---------|-------------------|
| `cmux --json list-panes` | Returns JSON, **strips geometry fields** (use raw socket for those). |
| `cmux --json identify` | Full JSON with geometry. |
| `cmux --json new-workspace` | Plain text `OK workspace:N`. |
| `cmux --json new-split` | Full JSON `{pane_ref, surface_ref, type, ...}`. |
| `cmux --json version` | Plain text `cmux X.Y.Z (...)`. |

Treat each command separately. Don't assume `--json` returns JSON.

### `tab-action --action` allow-list is unwritten

The error `invalid_params: Unknown tab action` is the discoverer here. Known-good actions: `rename`. Common guesses that DON'T work: `select`, `switch`, `focus`, `activate`, `next`, `previous`, `close`. Use `surface.move`, `surface.close`, `surface.focus` instead.

### CLI's `tools claude usage` titles indicate a tools binary in your PATH

Not a cmux quirk — but if your tab titles show `tools claude usage`, that's GenesisTools' claude-usage tool running, not a cmux feature.

### Refs are session-scoped

Killing and relaunching cmux assigns brand-new refs. The 4 workspaces I had as `workspace:1..4` may all get different refs after a restart. Profile JSON stores titles + structure only, never raw refs.

### Pane text reads are ANSI-stripped — colors cannot be captured

`cmux capture-pane`, `cmux read-screen`, and the raw `surface.read_text` RPC all return **plain text only**. There is no `--ansi` / `--raw` / `--with-escapes` flag, and probing param variants (`ansi:true`, `raw:true`, `include_ansi:true`, `format:"ansi"`) on `surface.read_text` confirms the daemon never emits escape sequences. `read-screen --help` even spells it out: "Read terminal text from a surface as plain text."

This is why `tools cmux profiles restore` paints back saved screens **monochrome**. The structure (login banner, prompts, command output) is preserved but colors are lost. tmux's equivalent (`tmux capture-pane -e`) does emit ANSI; cmux 0.63.2 has no analogue.

### `cmux capture-pane --scrollback` returns visible content only (in 0.63.2)

Despite the help text ("Include scrollback (not just visible viewport)"), `cmux capture-pane --scrollback --lines 5000 --surface <ref>` returns the same N lines as plain `capture-pane --surface <ref>` — i.e. the visible viewport, no real scrollback. The raw `surface.read_text {"scrollback":true}` RPC does return full scrollback (3000+ lines) but is affected by the V1 routing bug (issue #3189) — it always returns the focused surface's content regardless of the `surface` param. Net effect: per-surface scrollback access is currently impossible in 0.63.2 without a focus-switching dance.

This means `tools cmux profiles save` can only capture the **visible** rows of each pane. For long-running TUIs (Claude Code, vim) where the launching shell command (`claude --resume <id>`) has scrolled past the visible area, the `command` field will be empty — there is nothing for the parser to find.

---

## What `tools cmux profiles ...` actually does

A walkthrough of the exact cmux calls our CLI makes.

### `tools cmux profiles save <name>`

```bash
cmux identify --json                           # resolve socket path (cached)
cmux --version                                  # for cmux_version field

# Discover (raw socket — CLI strips refs from list-windows)
RPC window.list                                 # → [{ref, id, index, ...}]
for each window:
  RPC workspace.list { window: <ref> }          # → workspaces with current_directory

# Per workspace (sequential):
  cmux select-workspace --workspace <ref>       # FOCUS FLICKER (~400ms)
  RPC pane.list { workspace: <ref> }            # geometry, container_frame
  for each pane:
    cmux --json list-pane-surfaces --workspace <ref> --pane <ref>
    for each surface:
      if browser: RPC browser.url.get { surface: <ref> }
      if terminal:
        cwdFromTitle(title)                                  # per-pane cwd from OSC-7 title
        cmux capture-pane --workspace <ref> --surface <ref>  # visible content, ANSI-stripped
        lastCommandFromCapture(text)                         # parse trailing shell prompt

# After everything is captured:
cmux select-workspace --workspace <originally-focused-ref>   # restore focus

# Write JSON (atomic rename)
~/.genesis-tools/cmux/profiles/<name>.json
```

### `tools cmux profiles restore <name>`

```bash
read profile JSON

for each window in profile:
  if profile-windows > current-cmux-windows:
    cmux new-window
  for each workspace in window:
    RPC workspace.create { name: "<prefix><orig>" }   # → workspace_ref
    cmux rename-workspace --workspace <new> "<prefix><orig>"  # name actually sticks now

    cmux select-workspace --workspace <new>           # FOCUS FLICKER

    # Topology
    RPC pane.list { workspace: <new> }                # confirm 1 starting pane
    buildSplitTree(saved-pane-pixel_frames)           # binary tree from rect adjacency,
                                                      # each internal node carries the saved
                                                      # leftFraction or topFraction (0..1)
    applyTree:
      for each internal node:
        cmux --json new-split <right|down> --surface <anchor> --workspace <new>
        # Resize the JUST-CREATED border immediately (one pair of panes shares it now;
        # cmux's resize-pane errors with "no adjacent border in direction X" once deeper
        # splits exist, so global post-hoc convergence does not work).
        # cmux's --amount is in PIXELS (empirically — despite "tmux-compatible alias"),
        # so multiply cell-deltas by pane.cell_width_px / cell_height_px.
        # Direction must match the pane that has a neighbor in that direction:
        #   • move border LEFT (shrink old / grow new)  → -L on NEW (right pane)
        #   • move border RIGHT (grow old / shrink new) → -R on OLD (left pane)
        #   • move border UP   (grow new bottom)        → -U on NEW (bottom pane)
        #   • move border DOWN (grow old top)           → -D on OLD (top pane)
        # Re-read pane.list after each call (cmux clamps to neighbour min size and rounds
        # to whole cells) and loop up to 8 attempts; bail when a call doesn't reduce delta.
      for each leaf:
        record map[savedIndex] = current pane ref

    # Surfaces
    for each saved pane:
      while current surfaces < saved surfaces:
        cmux new-surface --pane <ref> --workspace <new> --type <terminal|browser> [--url ...]
        # NOT raw RPC surface.create — that ignores the pane param and creates in the
        # focused pane (tabs would all stack into the anchor pane). See gotcha above.
      for each saved surface:
        cmux rename-tab --workspace <new> --surface <ref> "<title>"
        if terminal:
          # Single composite shell command, sent as one cmux-send payload:
          #   cd <cwd> 2>/dev/null              ← silently restore working dir
          #   ; printf '\033[2J\033[3J\033[H'   ← clear screen + scrollback + cursor home
          #   ; printf %s '<base64>' | base64 -d ← print the saved screen text back out
          #   \n                                 ← execute the line
          #   <command>                          ← typed but NOT executed (no \n)
          # The end result: the new pane shows exactly the saved screen + a fresh prompt
          # below, with the saved last command pre-typed and waiting for Enter.
          cmux send --workspace <new> --surface <ref> "<composite payload>"

cmux select-workspace --workspace <originally-focused>   # restore focus
```

Limitations baked into this design:

- **Monochrome.** Saved screen content is ANSI-stripped by cmux 0.63.2 (see "Pane text reads are ANSI-stripped" above). Replay shows the structure but loses colors.
- **Visible-rows only.** Scrollback is not currently retrievable per-surface (CLI `--scrollback` returns visible only; raw RPC `surface.read_text {scrollback:true}` is V1-routing-bugged). Long-running TUI panes lose their pre-TUI shell command.
- **Pre-typed command can be wrong** if the parser hits a non-shell prompt that uses `❯`/`$` glyphs. We mitigate by only matching prompts with directory/git/host context (oh-my-zsh robbyrussell, `[user@host]$`, `user@host:dir$`); bare-glyph prompts are deliberately rejected.

That's the entire integration surface. Everything else (cookies, network mocking, sidebar UX) is downstream cmux features we don't currently use.
