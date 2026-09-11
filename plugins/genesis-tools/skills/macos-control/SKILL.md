---
name: macos-control
description: Inspect and control macOS app UI through the Accessibility API, and record short screen captures reviewed frame-by-frame. Use when automating native apps — clicking buttons, filling forms, reading element state, finding elements, getting window bounds, driving browser tabs — or when the user wants a short screen recording of an animation/transition/flicker reviewed via a contact sheet, optionally pushed to a vitrinka board. Works from any agent host; native Computer Use and Peekaboo are optional extras, not requirements. Triggers on "click button in app", "fill form in native app", "automate macOS app", "list UI elements", "find button", "read text field value", "get window position", "interact with native app", "click without stealing focus", "switch browser tab", "record the screen", "capture this transition", "Xs recording", "Nfps", "watch this animation", "why does it jump/flicker", "record this app for a few seconds", "push the recording to a board".
---

# `tools control` — macOS UI inspection, control and recording

Native CLI over the Accessibility API. `tools macos control` is an alias. The binary
(`native/ax-tool`) auto-builds on first run and is 10-30x faster than osascript.

**Read the decision rule below before anything else. It decides which half of this skill you use.**

## 🛑 First, check you are on a build that HAS these commands

`see`, `act` and `cursor` are newer than `master`. `tools` on PATH runs whichever checkout
owns the `tools` executable, which is usually the main one, so from a worktree or before this
lands you will be asking an older build.

**`tools control <unknown-subcommand> --help` exits 0 and prints the PARENT help.** It does
not error. Verified 2026-09-11: `tools control act --help` and `tools control zzznotreal
--help` both exit 0 with 11,479 bytes of top-level help. A zero exit code therefore proves
nothing, and an agent that trusts it concludes the subcommand does not exist.

Read the FIRST LINE of the help instead:

```bash
tools control act --help | head -1
# "Usage: control act [options]"  -> the build has it
# "Usage: control [options] [command]"  -> it does NOT; you are on an older checkout
```

From a worktree, run the local entrypoint rather than the PATH one:

```bash
bun src/control/index.ts act --help | head -1
```

## The decision rule

There are two command families and they are both correct. Pick by what the task needs.

| The task | Use | Why |
|---|---|---|
| Read something, or act once where a mistake is cheap | **selector commands** (`find`, `press`, `click`, `set`, `window`, `list`) | One call. Human-readable output. About 300-450 ms. Roughly 170 bytes back. |
| The action must be verified, must not steal focus, or targets a moving UI (browser tabs, lists, anything animating) | **`see` → `act --refresh`** | Validated snapshot token. Refuses a stale tree. Background delivery without moving the pointer. About 0.6 s for the cycle, 8 kB back; `see --since` cuts a re-inspection to about 1.6 kB. |
| Multi-frame recording of a transition | **`capture`** | Only the recorder produces video, diff-sampled frames and contact sheets. |
| A repeatable click-through with pass/fail per step | **`run plan.json`** | Declarative, asserted, re-runnable. |

Measured 2026-09-11 on this machine: selector `press` + `find` = 541 ms and 166 bytes;
`see` + `act` + `see` = 1226 ms and 17,608 bytes. Same day, after the native port: `see`
(200 ms, 7,823 bytes) + `act --refresh` (378 ms, the settled state included) replaces the
third call, and `see --since` returns 1,569 bytes for the same window. The verified path still
costs about 10x the context of a selector command. Spend it when the guarantee matters, not
by default.

## Providers

`tools control` is the one provider that always works. It needs macOS, Bun, a Swift
toolchain, and the Accessibility and Screen Recording grants. It does not need an OpenAI
account, a Codex session, or Peekaboo. Recording is the single optional Peekaboo dependency.

| Provider | Entry point | Reference format |
|---|---|---|
| **GenesisTools** (default) | `tools control see` then `tools control act` | snapshot token + integer element index |
| Claude Code native computer use | `mcp__computer-use__*` MCP tools | screen coordinates after `request_access` |
| Claude Code Peekaboo | `mcp__peekaboo__*` MCP tools | opaque Peekaboo IDs + snapshot |
| Codex native computer use | `node_repl` `js` tool with `@oai/sky` | `element_index` from `get_app_state` |

🛑 **Never translate an index or a token between providers.** They are different numbering
schemes. A working CLI does not prove a host's native computer use works, and the reverse.

Honor an explicit provider choice by the user. If they ask for native Computer Use, check
whether the host actually exposes it before claiming it is unavailable, and report the exact
error if it is not there. Details per provider: [references/providers.md](references/providers.md).

## Quick recipes

```bash
# What is even in this app?
tools control preflight --app <name>                 # RUN FIRST: screens, frontmost, windows, elements, browser tab, suggested plan
tools control apps                                   # valid --app values

# Press a button in a native app, one call
tools control press --app Genesis --id save-btn

# Press it WITHOUT stealing the user's focus (AXPress is position independent and never raises)
tools control press --app Genesis --id save-btn      # already focus-safe
# ...or, when the control only responds to a real mouse click:
tools control see --app Genesis > /tmp/s.json
tools control act --app Genesis --snapshot "$(jq -r .snapshot /tmp/s.json)" \
    --element <N> --action click --background        # window-addressed, pointer never moves

# Act AND read the settled result in one call (no second see)
tools control act --app Genesis --snapshot "$(jq -r .snapshot /tmp/s.json)" \
    --element <N> --action press --refresh > /tmp/s2.json   # .after holds the new tree + token

# Re-inspect and get only what moved since a previous see
tools control see --app Genesis --since /tmp/s.json          # .changes + only added/changed rows

# Fill a text field and PROVE the text landed
tools control set --app Genesis --id auth-email --value "alice@example.com"   # reads back, retries once, fails loud

# Wait for a result instead of guessing with sleep
tools control wait --app Genesis --q "status" --contains "Saved" --timeout 5000

# Screenshot one specific window
tools control screenshot --app Genesis --window "Settings" --path /tmp/s.png

# What can I click? numbered boxes on every interactable element
tools control screenshot --app Genesis --path /tmp/s.png --annotate --json

# The tree says "Submit" but the screen says something else — read the pixels
tools control ocr --app Genesis --window "Settings"

# Draw on an image you already have
tools control draw /tmp/s.png --out /tmp/s-annotated.png \
    --annotate '[{"kind":"highlight","rect":{"x":748,"y":812,"w":1246,"h":430},"label":{"text":"Build pipeline"}}]'

# Browser tabs: text lives in AXDescription, tabs are AXRadioButton
tools control find --app "Brave Browser" --role AXRadioButton
tools control click --app "Brave Browser" --desc "Pull Request" --role AXRadioButton
```

## Selector commands (the cheap family)

### Discovery

```bash
tools control preflight --app <name>                 # one call: screens, frontmost, windows, elements by role,
                                                     #   browser tab, suggested plan
                                                     #   --wanted screens,windows,elements[,elements:<Role>],browser,frontmost,plan
tools control apps                                   # running apps — valid --app values
tools control list --app <name> [--depth N]          # flat list of all elements (max 2000)
tools control tree --app <name> [--depth N]          # hierarchical nested tree
tools control find --app <name> --role button        # fuzzy: "button" matches AXButton
tools control find --app <name> --title "Save"       # by title (substring, case-insensitive)
tools control find --app <name> --text "YouTube"     # title + desc + value at once (OR)
tools control find --app <name> --desc "Chat"        # by description (most SwiftUI and browser elements)
tools control find --app <name> --subrole close      # fuzzy: "close" matches AXCloseButton
tools control find --app <name> --role button --title "Email" --exact   # --exact forces strict role match
```

Role and subrole matching is fuzzy by default. Add `--exact` for strict matching.

### Inspection

```bash
tools control get --app <name> --id <axId>           # role/title/value/description
tools control attrs --app <name> --id <axId>         # ALL attributes, decoded
tools control actions --app <name> --id <axId>       # available AX actions
tools control window --app <name>                    # window bounds x,y,width,height + minimized/fullscreen
tools control dump --app <name> [--pretty]           # windows + every on-screen element with scroll-clip visibility
                                                     #   the instrument for overlap, clipping, off-window controls
tools control typography --app <name> [--pretty]     # rendered font name/size + sRGB rgba per static text
                                                     #   legibility and contrast checks with no screenshot
tools control hittest --at x,y [--pretty]            # which element the system delivers a click there to
                                                     #   takes NO --app; answers "is this control really reachable"
```

### Interaction

```bash
tools control set --app <name> <target> --value "text"        # text field: clear+type, then read back (1 retry, fails loud)
tools control press --app <name> <target>                     # AXPress — position independent, does not raise the app
tools control click --app <name> <target>                     # CGEvent click at element center
tools control perform --app <name> <target> --action AXShowMenu
tools control focus --app <name> [<target>]                   # activate app + focus element
tools control focus --app <name> <target> --no-activate       # focus WITHOUT raising — use while the user works
tools control type --app <name> --text "hello" [<target>]     # real keystrokes + hard verify ([--clear] [--return])
tools control scroll --app <name> --direction down [--amount N]
tools control scroll --app <name> <target>                    # no --direction: AXScrollToVisible
tools control hotkey --keys cmd,shift,a [--app <name>]
```

`type` and `hotkey` accept `--to-pid <pid>`, confining synthetic events to that one process
instead of the global HID tap. An invalid pid is rejected, never downgraded to the global tap.
`window` accepts `--no-raise` and `--action move|resize|minimize|maximize|close|focus`.

### Verification (replaces sleep-guessing)

```bash
tools control wait --app <name> <target> [--timeout 5000] [--interval 200]   # poll until it exists
tools control wait --app <name> <target> --gone
tools control wait --app <name> <target> --for enabled|focused
tools control wait --app <name> <target> --contains "Saved"
tools control assert --app <name> <target> [--expect V|--contains T|--gone]  # single shot, exit 1 on failure
```

Both work as plan steps, which is what turns a plan into a UI test.

### Vision

```bash
tools control screenshot --app <name> --path /tmp/s.png [--window T] [--crop x,y,w,h]
tools control screenshot --app <name> --path /tmp/s.png --annotate [--all]   # numbered boxes + legend in --json
tools control ocr --app <name> [--window T] [--crop x,y,w,h]                 # Vision OCR: text + pixel boxes
tools control ocr --image /tmp/s.png
tools control compare-screenshot a.png b.png [--max-mismatch 0.5] [--diff-out diff.png] [--json]
```

`--annotate` is the "what can I click?" picture. `ocr` reads rendered pixels, which is the
check that survives an app lying in its AX tree. Both default to the app's LARGEST window;
`--window <title>` scopes either.

### Draw on any image

```bash
tools control draw shot.png --annotate '[{"kind":"highlight","rect":{"x":748,"y":812,"w":1246,"h":430},"label":{"text":"Build pipeline"}}]'
tools control draw shot.png --annotate plan.json --out annotated.png [--preset review-red|callout-amber|redact]
```

Kinds: `highlight` (rounded-rect outline plus wash, the review register), `box`, `ellipse`,
`arrow {from,to}`, `label {at,text}`, `blur {rect,strength}` (redact), `crop {rect}` (applied
LAST), `grid {step,originOffset,labels}` (coordinate finder). Coordinates are NATURAL IMAGE
PIXELS. Annotations draw in array order. The input is never mutated without `--in-place`.
MCP twin: `annotate_image` on the genesis-tools server.

Pick the capture source deliberately: **web app** → playwright `browser_take_screenshot`
(exact CSS pixels, no window chrome, full-page); **native app, OS surface, cross-app flow** →
this skill's `screenshot`. Neither produces an annotated artifact by itself. That is `draw`'s
job, which is why it works on any source.

### Snapshot / restore (leave the machine as you found it)

```bash
SNAP=$(tools control snapshot)              # mouse position + frontmost app/window, as JSON
# ... do focus-stealing things ...
tools control restore --snapshot "$SNAP"    # takes the literal JSON, not a file path
```

⚠️ `tools control snapshot` is unrelated to a `see` token. Never pass one where the other is
expected. Plans do the same thing declaratively with `"restore": true`.

### Record a plan instead of writing one

```bash
tools control record-plan start --record all       # commands | activity | all
tools control record-plan stop --out plan.json
tools control record-plan --record activity --duration 20 --out plan.json    # one-shot
```

`commands` logs subsequent action commands from any terminal. `activity` records real user
clicks and keys through a CGEvent tap, resolved to AX elements. Review before running.

🛑 The commands recorder is machine-global. Commands from another terminal or session are
marked `"_foreign"`; `stop --exclude-foreign` drops them. Concurrent subagents of the SAME
session are indistinguishable, so never run parallel agents through `tools control` while
recording.

## Targeting (`<target>`)

Every interaction and inspection command accepts:

- `--q <query>` — **universal search** across id, title, desc, value, role and subrole at
  once. Reach for this first when you do not know which attribute holds the visible text.
- `--id <axId>` — exact AXIdentifier.
- Any mix of `--role` / `--title` / `--desc` / `--subrole` (first match), `--window <title>`
  to scope, `--exact` for strict role matching.
- `--depth <n>` — search depth, default 15. Browser page content often needs 40; a 0-match
  result at the default depth is the hint.

Elements with no AXIdentifier are fully interactable:

```bash
tools control press --app Genesis --id nav-chat                                  # native app with an identifier
tools control click --app "Brave Browser" --desc "Reload" --role AXButton         # browser: description, no id
tools control press --app Genesis --desc "Account" --role AXButton                # tabs sharing one id
tools control click --app Genesis --subrole AXCloseButton --window Settings       # window buttons: subrole only
```

## `click` vs `press` vs `set`

| Command | Mechanism | When |
|---|---|---|
| `press` | AX action (AXPress) | Buttons and toggles in native apps. Position independent, works on obscured or scrolled-away elements, does not raise the app. |
| `click` | CGEvent at element center | A real mouse click. Exercises hit testing, works on web content, triggers hover and focus. |
| `set` | text fields: CGEvent clear+type then read back; other elements: AXValue write | Text fields, when you need the content verified. |
| `type` | CGEvent keystrokes | Real typing for autocomplete, validation, and non-AX inputs. |
| `focus` | activate + AXFocused | Bring app or element to front before typing. |
| `focus --no-activate` | AXFocused only | Focus without raising. Use whenever the user is working. |

### `click` scroll-safety

`click` checks the element center against visible window bounds. Scrolled out of view, it
falls back automatically: buttons to `AXPress`, text fields to `AXFocus`. The output then
carries `"fallback"` and `"warning"`. Below the fold, prefer `press` or `focus` + `type`.

## Gotchas

- 🛑 **One keyboard, one frontmost app. Keyboard work is machine-exclusive.** `set`, `type`
  and `hotkey` activate the target app and stream real CGEvents. A concurrent session doing
  the same steals frontmost mid-type and the keystrokes land in the wrong app. Parallelise
  read-only commands freely; serialise every interaction.
- ⚠️ **App-level screenshots capture the wrong window** when an app has several, because apps
  mark popups and strips as "main". Always pass `--window "<title>"`.
- ⚠️ **Browser elements use AXDescription, not AXTitle.** Tab text is in `desc`. Use
  `find --text` or `find --desc`.
- ⚠️ **Browser tabs are `AXRadioButton`**, not `AXButton`. `--role AXButton` finds bookmark
  bar items instead.
- ⚠️ **Two instances of the same app** (two browser profiles) fail loud with a candidates
  list. Target one with `--app <pid>`; pids come from `tools control apps`.
- ⚠️ Negative window coordinates are legitimate on a multi-display Mac, not junk data.
- ⚠️ With the normal `tools` launcher, macOS grants belong to GenesisTools.app. Running
  `ax-tool` or Bun directly may use a different responsible process. Read the permission
  error to identify the missing grant instead of assuming a terminal grant applies.

## Output

Default output is one human-readable summary line (`pressed nav-chat`,
`assert ok board-poll-hint`). `--json` gives machine JSON: `{"ok": true, ...}` or
`{"ok": false, "error": "..."}`, compact unless `--pretty`. In `list` and `find` tables the
label column shows title, else desc, else value — static text usually surfaces in value,
buttons in desc.

## Contracts that bite

**Focus.** `press`, `get`, `find`, `list`, `tree`, `attrs`, `actions`, `window`, `dump`,
`typography`, `hittest`, `screenshot` and `ocr` **do NOT activate or raise the app**. `press`
goes through AXPress, so it works on an obscured or scrolled-away control while the user keeps
typing elsewhere. The commands that DO take the machine are `set`, `type`, `hotkey` and
`focus` (without `--no-activate`). This is the answer to "click it without stealing focus":
use `press`, or `act --action click --background`.

**Exit codes, measured 2026-09-11:**

| Command | Situation | Exit |
|---|---|---|
| `wait` | condition met | 0 |
| `wait` | timeout | **1**, message names the poll count and the unmet condition |
| `assert` | holds / fails | 0 / **1** |
| `set` | element not settable | **1** (`element Five (AXButton) is not settable`) |
| `run` | any step failed | **1**, plus `N/M steps passed` on the last line |
| `compare-screenshot` | within gate / over / unusable inputs | 0 / 1 / 2 |
| `find` | **zero matches** | **0** |

🛑 **`find` exits 0 when it matches nothing.** Never branch on its exit code to decide whether
an element exists; read the match count, or use `assert`. On 0 matches it prints a depth hint,
because browser page content routinely exceeds the default `--depth 15`.

**Ambiguity.** `--role` / `--title` / `--desc` combinations take the FIRST match, silently and
in tree order. Only `--q` inside a capture plan's AX actions refuses on ambiguity. When more
than one element can match, scope with `--window`, add `--exact`, or list first with `find`
and target the one you meant.

**Crop units.** `screenshot --crop` and `ocr --crop` are `x,y,w,h` in PIXELS of the captured
image, origin top-left. `draw` annotations are natural image pixels. Capture-runner crop
markers are frame pixels, which is points times the display scale factor. Window geometry from
`window` and `see` is in POINTS. Convert deliberately; the retina factor is 2 on the built-in
display and 1 on external panels.

## The verified family: `see` → `act` → `see`

Use it when the action must be verified, must not steal focus, or targets a moving UI.

1. **Inspect** the intended app and exact window. Treat a permission error or an empty tree
   as unresolved, never as evidence of empty data.
2. **Select** an element from that observation. Anonymous duplicate controls need an index,
   not a guessed label.
3. **Act** once. Coordinate desktop input with other sessions.
4. **Refresh** before choosing the next action. A dispatch acknowledgment is not proof the UI
   changed. `refreshRequired: true` means dispatched, not succeeded. `act --refresh` does
   this step for you: it waits until two consecutive tree reads agree (one second cap) and
   returns the same payload `see` prints under `after`, so one call replaces two.

```bash
tools control see --app com.apple.calculator --path /tmp/calc.png > /tmp/calc.json
tools json /tmp/calc.json          # read elements[] and screenshot.path

tools control act --app com.apple.calculator \
    --snapshot "$(jq -r .snapshot /tmp/calc.json)" --element N --action press

tools control see --app com.apple.calculator \
    --window-id "$(jq -r .window.id /tmp/calc.json)" --path /tmp/after.png > /tmp/after.json
```

`jq` is only reading the token; any client can parse the JSON itself. Quote the token. Check
each exit code; never hide a failing action behind a pipeline.

**What `see` actually returns.** Field names matter, so here is a real (trimmed) result for
Calculator. Every element carries an `index`, which is the integer `act --element` wants.

```json
{
  "app": "com.apple.calculator",
  "pid": 71368,
  "scope": "window",
  "expiresInSeconds": 120,
  "bulk": true,
  "snapshot": "eyJwaWQiOjcxMzY4LCJkZXB0aCI6MjAsImxhdW5jaCI6…",
  "window":     { "id": 24968, "index": 0, "title": "Calculator", "x": 1761, "y": 842, "width": 230, "height": 408 },
  "screenshot": { "path": "/tmp/calc.png", "width": 460, "height": 816 },
  "truncated": null,
  "ok": true,
  "elements": [
    { "index": 0,  "role": "AXWindow", "AXTitle": "Calculator", "AXIdentifier": "main",
      "AXSubrole": "AXStandardWindow", "actions": ["AXRaise"], "depth": 0, "visible": true,
      "x": 1761, "y": 842, "width": 230, "height": 408, "AXFocused": "0" },
    { "index": 8,  "role": "AXStaticText", "AXValue": "4", "AXEnabled": "1", "depth": 6,
      "valueSettable": false, "visible": true, "x": 1962, "y": 931, "width": 19, "height": 36 },
    { "index": 18, "role": "AXButton", "AXDescription": "5", "AXIdentifier": "Five",
      "AXEnabled": "1", "actions": ["AXPress"], "depth": 5, "visible": true,
      "x": 1825, "y": 1029, "width": 48, "height": 48 }
  ]
}
```

Notes that save a round trip:

- Attribute keys keep their raw AX names (`AXTitle`, `AXDescription`, `AXValue`,
  `AXIdentifier`, `AXSubrole`, `AXEnabled`, `AXFocused`). There is no lowercase `title` or
  `identifier`. Booleans arrive as the strings `"0"` and `"1"`.
- `x`/`y`/`width`/`height` are already GLOBAL screen points, so an element centre is directly
  usable as `--coords`.
- `actions` is the list `--action perform --ax-action NAME` may name. An element with no
  `AXPress` in it cannot be pressed.
- Picking an element is ordinary JSON work:
  `jq '.elements[] | select(.AXDescription=="5") | .index'`.

⚠️ The screenshot is in RETINA PIXELS (460×816 here) while the window is in POINTS (230×408).
Convert before using an image pixel as a coordinate; the formula is below.

**Window selection.** With several windows `see` exits 1 and lists `windows` candidates with
their current zero-based indexes. Re-run with `--window-index N`. It never picks the largest
window. `window.id` is a CG window identity, not an index: refresh the same window with
`--window-id ID`, because focusing or closing windows reorders indexes. `--window-id` and
`--window-index` are alternatives, never combined.

**Scope.** `--scope chrome` omits web-area descendants, which keeps browser tab and toolbar
references stable while page content changes. Web-content coordinates need the default
`window` scope.

**Depth.** `--depth` is 1-50. A truncated tree fails rather than issuing partial references.

**Read path.** `"bulk": true` means the tree came from one `AXUIElementCopyHierarchy` round
trip, the same private call Sky uses; `false` means the per-attribute walk. Both produce
byte-identical rows. The bulk read is about 2x faster on large windows (Brave, 1,661 elements:
0.9 s against 2.0 s) and a tie on small ones. Chrome scope always walks, because the bulk read
cannot stop at a web area. `AX_TOOL_NO_BULK=1` forces the walk, which is the A/B control.

### `see --since <previous.json>`: only what moved

```bash
tools control see --app Genesis --path /tmp/s1.png > /tmp/s1.json
# ...an action or two later...
tools control see --app Genesis --since /tmp/s1.json > /tmp/s2.json
```

The second call still returns a fresh `snapshot`, `window` and `screenshot`, but `elements`
holds only the rows that were added or changed, and `changes` carries `added` (indexes),
`removed` (index, role, label), `changed` (index, previousIndex, and each field's `from`/`to`),
`unchanged` (a count) and `indexMap` (old index → new index for every row that survived).
Rows are matched by depth, role, identifier, title, description and subrole, in tree order,
so a control whose label changed ("All Clear" → "Clear") shows as removed plus added: the label
is the identity you target by. A different window id makes the diff refuse and returns the
full rows with `since.comparable: false`.

### `act --action` matrix

| Action | Extra fields | Behaviour | Needs the app frontmost? |
|---|---|---|---|
| `get` | — | read the exact indexed element after validation | no |
| `press` | — | invoke the element's AXPress; does not raise another window | no |
| `click` | `--double`, `--button left\|right\|middle`, `--background`, `--coords x,y` | window-addressed click at the element center or observed point | 🛑 **yes, unless `--background`** |
| `move` | `--coords x,y`, `--background` | window-addressed hover event; named storage is `tools control cursor` | no with `--background` |
| `drag` | `--to X,Y`, `--duration 0.1–5`, `--coords`, `--background` | left-button drag inside the selected window | no with `--background` |
| `set` | `--value TEXT` | set AXValue and read it back; fails if not settable; no typing fallback | no |
| `perform` | `--ax-action NAME` | invoke an action present in the observed actions list | no |
| `focus` | — | activate and raise the selected window, then focus the element | it does the activating |
| `scroll` | `--direction up\|down\|left\|right`, `--pages 1–20` or `--pixels 1–10000`, `--coords`, `--background` | pages use the receiving AX scroll-area viewport; a missing viewport requires explicit pixels | no with `--background` |
| `type` | `--text TEXT` | single-line Unicode into the focused element, max 256 UTF-16 units | 🛑 **yes** |
| `select` | `--text MATCH` (+`--prefix`/`--suffix`) or `--range START,LENGTH`, `--selection text\|cursor_before\|cursor_after` | select a unique literal match or a UTF-16 range | no |
| `paste` | `--text PAYLOAD`, `--format text\|md\|html` | paste at the current selection in the already focused input | 🛑 **yes** |
| `key` | `--keys cmd,a` | one supported key plus modifiers, confined to the selected process | 🛑 **yes** |

**`--refresh` (any action) and `--path <png>` (with `--refresh`).** After the action, `act`
waits until two consecutive tree reads agree (50 ms apart, one second cap), then returns
under `after` the same object `see` prints: a new `snapshot` token, `elements`, `window`,
`screenshot` and `bulk`. `refreshRequired` is then `false`. A refresh that could not settle
lands as `after: { ok: false, error }` while the action itself stays `ok: true`, because the
action was dispatched and must not be retried on that account. Measured on Calculator:
378 ms against 210 ms for a plain `act`, and no third tool call.

🛑 **The four foreground-only actions refuse with `wrong frontmost app/window; focus
explicitly and refresh` when the target is not already frontmost.** A background agent
driving from a terminal cannot use them without taking the machine over. Verified
2026-09-11. Use `press`, `set`, `select` and `click --background` instead wherever you can.
`act focus` can also fail with `AXRaise failed or timed out (AX -25205)`.

`type` and `key` never silently focus an input, and embedded newlines in `type` are refused —
submit with an explicit `key` action. Use `select` → `see` → `paste` to replace a match.
HTML paste also supplies raw markup as plain text. Clipboard restoration is best effort,
because AppKit has no atomic compare-and-swap.

### Snapshot guarantees, and their limits

Tokens expire after 120 seconds. Validation covers process start time, window identity,
indexed tree contents, geometry, state and index bounds. The tree and the screenshot come
from the same window, and capture refuses changes observed during inspection.

This validates observable state, not permanent AX object identity, and not a lock on the
desktop. Fully identical anonymous controls swapped for each other cannot be detected.
Another process can change the UI immediately after validation. Tokens are observation data,
never credentials: do not edit them, cache them for later plans, or treat them as
authorization.

⚠️ **Element indexes shift whenever the tree changes.** Pressing a Calculator digit moved
every later index by two. Always re-read the index from the newest `see`, never from memory.

### Click a bare point without moving the real mouse

```bash
tools control act --app Calculator --snapshot "$(jq -r .snapshot /tmp/calc.json)" \
    --action click --background --coords X,Y
```

Coordinates are global screen points inside that snapshot's window; omit `--element`.
Element `x`/`y`/`width`/`height` are already global screen points. To convert a screenshot
pixel instead:

```text
screenX = window.x + imageX * window.width  / screenshot.width
screenY = window.y + imageY * window.height / screenshot.height
```

The target app's hit test must agree the point belongs to the selected window, so an
overlapping window of the same app causes a refusal. Current macOS needs a private
CoreGraphics window-location setter for correct routing; the tool checks it exists and
refuses the click otherwise. That is a macOS constraint, not a Codex dependency.

### Independent software cursor

```bash
tools control see --app com.brave.Browser --window-id ID --scope chrome > /tmp/b.json
tools control cursor move --name brave --app com.brave.Browser \
    --snapshot "$(jq -r .snapshot /tmp/b.json)" --coords X,Y
tools control see --app com.brave.Browser --window-id ID --scope chrome > /tmp/b2.json
tools control cursor click --name brave --snapshot "$(jq -r .snapshot /tmp/b2.json)"
tools control cursor show --name brave
```

`cursor move` sends a window-addressed move event and saves its own named position. It never
moves or restores the user's hardware pointer. `cursor click` uses that saved position, and a
refreshed token must belong to the same app launch and window. `cursor show` is read-only.
Movement changes hover state, so inspect again before clicking.

The reproducible tab proof uses these same commands:

```bash
bun src/control/scripts/brave-tabs.ts --window-id ID --proof /tmp/brave-tabs-proof.json
```

It clicks every visible tab in an existing window, verifies each selection, restores the
original tab, and refuses hidden tabs or a changed inventory rather than claiming partial
coverage.

## Plan runner (`tools control run`)

One schema covers sequential automation, timed timelines and recordings:

- no `atMs` anywhere → sequential, `delayMs` between steps
- any step has `atMs` → timeline, steps fire at their offset from start
- `capture{}` present → the whole plan goes to the recorder (`steps` aliases its `actions`)

```json
{
  "app": "Genesis",
  "restore": true,
  "delayMs": 300,
  "steps": [
    { "do": "focus" },
    { "do": "press", "id": "settings-open" },
    { "do": "wait", "q": "Account", "timeout": 3000 },
    { "do": "click", "desc": "Account", "role": "button" },
    { "do": "assert", "id": "status", "contains": "Done" },
    { "do": "screenshot", "path": "/tmp/step5.png" },
    { "do": "click", "subrole": "close", "window": "Settings" }
  ]
}
```

```bash
tools control run plan.json          # ok/FAIL per step + total
tools control run plan.json --json   # full results array
```

🛑 **Top-level `ok` is true only when EVERY step passed. `failedSteps` carries the count.
Never trust `ok` alone without reading `failedSteps`.**

Fields: `app` (default for all steps, overridable per step), `restore`, `delayMs` (default
200, per-step `delay`), `exact`, `steps[].do` (any command name), and the same field names as
the CLI flags (`id`, `role`, `title`, `desc`, `subrole`, `window`, `value`, `text`, `action`,
`keys`, `direction`, `amount`, `path`). `wait` and `assert` additionally take `timeout`,
`interval`, `gone`, `for`, `expect`, `contains`.

Plan steps do NOT carry `see` snapshot guarantees. Never put a token or a `see` index into a
plan.

## Recording

```bash
tools control capture preflight [--app "<Name>"]   # ALWAYS FIRST when writing a capture plan
tools control capture --help                       # full plan and actions contract
tools control capture plan.json 1>result.json 2>err.log
tools control capture plan.json --annotate draw-plan.json   # capture + draw onto every kept frame
```

**Read [references/capture.md](references/capture.md) before writing any recording plan.** It
holds the recording discipline: duration and fps parsing, capture-target resolution, the
timing model, crop markers, focus re-assertion, review, troubleshooting and anti-patterns.
[references/peekaboo.md](references/peekaboo.md) has the Peekaboo contract.
[references/vitrinka.md](references/vitrinka.md) covers optional publishing.

The recorder is native since 2026-09-11: `ax-tool capture` (ScreenCaptureKit) records,
diff-samples and tiles, and `ax-tool screens` lists displays, so a plan needs no Peekaboo.
The result says `capture.data.source: "native"`. Peekaboo is the fallback, chosen with
`capture.backend: "peekaboo"` or automatically when the native recorder writes no frame.
`duration` is seconds on both.

❗ **Peekaboo 4 changed its grammar and the recorder was repaired for it on 2026-09-11**
(branch `feat/control-native-port`): `screen list` and `window list` replace the removed
`list`, `press <chord>` replaces the removed `hotkey`, `--at --global --foreground` replaces
`--coords`, and the clickmap screenshot now comes from `ax-tool screenshot`. On an older
checkout `capture preflight` dies with `undefined is not an object (evaluating
'activeScreen.scaleFactor')`; that is the symptom of the unrepaired wrapper, not of empty data.

Capture plans support three AX action types with the same targeting as the CLI: `ax-set`,
`ax-press` (both fall back to osascript without the native binary) and `ax-perform` (native
only). Plain verbs are auto-mapped inside a `capture{}` plan (`press`→`ax-press`,
`set`→`ax-set`, `perform`→`ax-perform`, `id`→`axId`), and the recorder has extra action types
(click, hotkey, type, scroll, crop and screenshot markers) that plain plans do not.

## Permissions

Accessibility and Screen Recording, granted to GenesisTools.app rather than to the terminal.
Check with `tools macos permissions`; it exits 1 while something is missing and names the
pane to open. An empty result from a permission-gated command is never proof of empty data.

## Maintenance

```bash
# from the GenesisTools repo, after editing any example in this skill:
bun plugins/genesis-tools/skills/macos-control/scripts/check-help.ts --repo .
```

⚠️ `--repo .` is required from a worktree. Without it the script falls back to `tools` on
PATH, which runs the MAIN checkout, and every probe fails against the wrong build.

```bash
bun src/control/scripts/live-smoke.ts          # native regression flow; opens a dedicated test app, needs the desktop
bun run test src/control                       # 44 tests
swift test --package-path native/ax-tool       # 53 tests
```

Never turn a failed live flow into a success claim by switching to another provider or by
discarding the refusal case.

## Common AX actions

| Action | Meaning |
|---|---|
| `AXPress` | click / activate (the `press` shortcut) |
| `AXRaise` | bring window to front |
| `AXShowMenu` | open context or dropdown menu |
| `AXConfirm` / `AXCancel` | dialog buttons |
| `AXIncrement` / `AXDecrement` | stepper or slider |
| `AXPick` | select menu item |
