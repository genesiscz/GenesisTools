# Recording — `tools control capture` (short motion, reviewed frame-by-frame)

The recording arm of macos-control. Everything here is multi-frame capture. Single-shot
element control lives in SKILL.md. Recording is the only part of this skill that needs the
external Peekaboo binary.

## 🛑 Current state on this machine, 2026-09-11

**`tools control capture preflight` is broken, and it is broken on master too.** Peekaboo 4.x
removed the `peekaboo list` command. `src/control/lib/peekaboo.ts:97` still calls
`["list","screens"]` and `:138` calls `["list","windows","--app",app,"--include-details","bounds"]`.
Both now return an error envelope, so `listScreens()` returns `[]` and preflight dies at
`src/control/lib/capture-runner.ts:677` with
`undefined is not an object (evaluating 'activeScreen.scaleFactor')`.

The v4 replacements are `peekaboo screen list` and `peekaboo window list`. `--include-details`
is gone; bounds come back by default. `peekaboo screen list --json` returns exactly the shape
`listScreens()` already expects, so the repair is a command rename at those two call sites.

Separately, the installed Peekaboo daemon refuses the default capture engine with
`predates safe process-lifetime ScreenCaptureKit ownership`. `--capture-engine classic` works.
Verified: `peekaboo capture live --mode window --app Calculator --duration 2000
--capture-engine classic` produced `keep-0001.png` and `contact.png`.

Until that is fixed, do not report "recording produced nothing". Report that the wrapper is
calling a removed Peekaboo command.

## The mental model

`peekaboo capture live` records a short screen video, **diff-samples** it (frames changing
less than `--threshold` percent against the previous kept frame are dropped, so an idle
screen collapses to one or two frames), and tiles the kept frames into **one contact-sheet
PNG**. Read that single PNG and you see the whole motion in one vision call. Every kept frame
also exists as a full-resolution PNG for drill-down.

Two Peekaboo surfaces, and the split matters:

- **CLI** (`/opt/homebrew/bin/peekaboo`) — the only surface with `capture live` and
  `capture video`. The recording step is always a shell-out.
- **MCP** (`mcp__peekaboo__*`) — single-shot tools only. Never expect `capture` there.

Review is inline by default: capture, read the contact sheet, answer. Vitrinka publishing is
opt-in; see [vitrinka.md](vitrinka.md).

## Step 1 — parse duration and fps from the request

- "2s" or "2 seconds" → `--duration 2`
- "4fps" → `--active-fps 4`
- **No duration given → `--duration 3`.** Never fall through to Peekaboo's own 60 s default.
  Always pass `--duration` explicitly.
- fps not given → omit `--active-fps` (default 8, max 15). `--idle-fps` defaults to 2.
  `--threshold` defaults to 2.5 percent. Raise it for noisy content such as video playback;
  lower it to catch subtle motion.

⚠️ Peekaboo 4.x takes bare duration values as **milliseconds**: `--duration 2000` is two
seconds, `--duration 2` may be read as two milliseconds. Check `capture live --help` on the
installed version before trusting either form.

## Step 2 — resolve the capture target

There is **no interactive rectangle picker anywhere in this stack.** Do not attempt or build
one. macOS `screencapture -i` rejects every video flag before any UI appears, and Peekaboo's
region mode hard-errors without an explicit `--region`. Bounds lookup IS the substitute for
"select an area".

Priority order:

1. **The window fills, or nearly fills, one display** → `--mode screen --screen-index N`.
   Empirically the most reliable mode. Get N from `peekaboo screen list --json`.
2. **The user named an app or window** → `--mode window --app "<Name>"`, optionally
   `--window-title "<title>"` or `--window-index N`. **Verify what you actually captured**
   by checking frame 1's dimensions and content. Browser "windows" include invisible 30-64 px
   strips that the AX API even marks as the main window, so a title match can silently
   capture a 387×64 popup instead of the real window. Ids and indexes come from
   `peekaboo window list --app "<Name>" --json`.
3. **A specific area with unknown bounds** → look the bounds up, then `--mode region
   --region "x,y,width,height"`. ⚠️ `--item_type application_windows` is the MCP tool's
   vocabulary; the CLI rejects it.
4. **Everything else** → `--mode screen` on the primary display.

⚠️ Negative coordinates are legal on a multi-display Mac (a display above or left of the
primary). Compare against `peekaboo screen list --json` positions before calling them junk.
Windows on another Space are invisible to single-shot capture: focus the app first, or
capture the screen.

⚠️ Avoid `--mode frontmost`. It produced both a bare crash with empty stdout and stderr and a
real bridge error in back-to-back tests, while screen and region modes never failed.

**`tools control capture preflight` is the intended shortcut for all of the above** once the
v4 breakage above is fixed. It prints screens (index, scaleFactor, framePixels, and
`originCG`, the top-left origin in the global point space that click coordinates live in),
the target app's window bounds in BOTH points and frame pixels, the active browser tab, and a
suggested plan skeleton. It kills the two classic footguns in one call: guessing the scale
factor (crop regions are frame pixels, which is points times scale) and guessing which window
is actually active. It separates real windows (height above 50 px) from phantom strips, and
cross-checks CGWindowList against the AX API so windows only CGWindowList sees are marked
`axVisible: false` and never chosen as the crop basis.

A suggested plan is a starting point, not proof it picked the right window. If the user named
one window, do not widen the capture to the whole screen just to dodge a targeting failure.

## Step 3 — plain capture, no interactions

```bash
peekaboo capture live --mode <screen|window|region> \
  [--app "<Name>"] [--region "x,y,width,height"] \
  --duration <ms> [--active-fps <n>] [--threshold <pct>] \
  --capture-engine classic \
  --json 1>/tmp/capture-out.json 2>/tmp/capture-err.log
```

Rules that came from real failures:

- **Always `--json`** and parse it. Never eyeball plain text.
- **Redirect stdout and stderr to SEPARATE files.** Never merge with `2>&1` and never pipe.
  A merged redirect produced a spurious empty-output failure that a clean separated-stream
  retry did not reproduce. Peekaboo also writes a `[Visualizer][INFO]` line to stderr, which
  corrupts stdout JSON the moment you merge them.
- **Nonzero exit with empty stdout AND empty stderr → retry the exact command once** before
  calling it a real failure. This pattern recurred and self-resolved on retry both times.
- Threshold tip: when the thing you care about is a small fraction of a large frame, drop
  `--threshold` to about 1. At the default 2.5 a topbar-only change on a 3440×1440 screen can
  be dropped entirely.

**Hunting a sub-second blip** (stale header, flash of wrong content, double-pop): use
`--active-fps 15 --threshold 0.1`. At 8 fps and 1 percent, a blip inside a 400 ms window
leaves only before-and-after frames, which proves nothing. Present it as a cropped strip:
cut the affected band out of each relevant frame (`magick <frame> -crop WxH+X+Y +repage`) and
`-append` them with timestamps. Homebrew imagemagick lacks freetype, so `label:` garbles
non-ASCII; keep labels ASCII.

**Always add `--video-out /tmp/<name>.mp4` on a blip hunt.** The MP4 keeps ALL captured
frames; the diff filter only prunes the kept-PNG set. Re-sample a narrower window later
without re-recording:

```bash
peekaboo capture video /tmp/<name>.mp4 --start-ms 4800 --end-ms 7000 --every-ms 66 --no-diff \
  --json 1>resample.json 2>resample.err
```

⚠️ **Blue-tint bug, seen on beta3 2026-07-15:** `capture video … --no-diff` corrupted colours
on re-sampled frames while live-kept frames from the same recording were fine. Re-check on
4.x before relying on it. Layout and timing in a blue frame are still valid; colours are not.
Prefer recording at a higher `--active-fps` with a low threshold over no-diff re-sampling.

`capture video` also ingests ANY existing recording (QuickTime `.mov`, a simulator recording,
a user-sent `.mp4`) into diff-sampled frames plus a contact sheet. When the user hands you a
video file, that replaces the recording step entirely.

## Step 3b — capture WITH interactions: always use the runner

**"With interactions" includes purely static sequences.** "Click through 5 tabs, screenshot
each" is still a timed plan, although for static sequences `tools control run` is better.
Hand-driving raw clicks plus images reproduces exactly the failures the runner removes:
clicks eaten on unfocused windows, no per-click refocus, and no `warnings[]` telling you a
click never landed.

🛑 **An LLM cannot drive timed actions through separate tool calls.** Measured: model thinking
plus tool round-trips add 3-8 s of jitter, so the recording either misses the transition or
the action lands before frame 1. Retrying "maybe faster this time" burns tokens and never
converges. Put the offsets in the plan. One process owns the whole timeline: it starts
`capture live`, detects the real recording start (first `keep-0001.png` on disk), then fires
each action at its planned offset. Observed drift is about 1 ms.

```bash
tools control capture preflight [--app "<Name>"]   # ALWAYS FIRST when writing a plan
tools control capture --help                       # the full plan and action contract
tools control capture plan.json 1>result.json 2>err.log
```

Parse `result.json`. It carries a **`warnings[]` array — read it first.** "Actions fired ok
but capture kept 1 frame" means the motion never reached recorded pixels. It also carries
per-action `plannedMs` against `actualMs`; audit the timing before trusting the frames.

Plan-level extras: `focus: {app, windowTitle?}` brings the target frontmost before recording
AND is re-asserted before every click, so set it in any plan that clicks. `browser` sets the
default app for `url` actions. `capture.countdownSec` shows a countdown for user-driven
transitions; the floating panel does not render when agent-spawned, so relay the countdown to
the user yourself.

**Declarative crops.** Crop markers live in the actions timeline:
`{atMs, do: "crop", region|target, label?}` then `{atMs, do: "crop-stop"}`. The runner crops
every kept frame inside each window, writes labelled crops to `<sessionDir>/crops/`, and
stacks them time-ordered into `crops/strip.png`. It ALSO writes
**`crops/strip-review.png` (longest side 1600 px) — read THAT one for vision review**; the
full strip is archival. Regions are FRAME pixels; labels ASCII only. Instead of a region you
can pass `target: {app, windowTitle?}`, whose bounds are looked up at the marker's `atMs` and
frozen there. A sequential `crop` with no `toMs` opens one window at a time; add `toMs` to
make a crop its own standalone window so two regions can be cropped from the same frames.

Two crop traps: a marker at `atMs: 100` EXCLUDES frame 1 at t=0, so start at 0 unless the
exclusion is deliberate; and verify the strip's content before presenting it, because if the
window moved display or Space between runs you get a beautifully labelled strip of wallpaper.

Beyond record-and-act the runner also does `recrop` (re-crop a finished run's frames with new
regions, no re-recording; `target` crops do not work there because bounds would be from now),
direct vitrinka publish, a dead-publish guard (motion actions fired but one or fewer frames
kept means publish is refused — fix the plan rather than forcing it), a raw `osascript`
escape hatch, and per-action `onError: "continue"|"abort"`.

### The `capture{}` plan object

Every panel agent that was asked to write a recording plan named this as the hardest part,
because the keys were only ever shown as CLI flags. They are camelCase inside the plan, and
`tools control capture --help` is the authority. The ones you will actually use:

```json
{
  "capture": {
    "mode": "screen",          // screen | window | region | frontmost (avoid frontmost)
    "screenIndex": 0,          // screen mode
    "app": "Genesis",          // window mode
    "windowTitle": "Settings", // window mode narrowing
    "region": "x,y,w,h",       // region mode
    "duration": 3,             // ALWAYS set this explicitly
    "activeFps": 8,            // default 8, max 15
    "idleFps": 2,              // default 2
    "threshold": 2.5,          // change % cutoff; ~0.1 for a sub-second blip
    "videoOut": "/tmp/run.mp4",// keep the MP4 so you can re-sample without re-recording
    "countdownSec": 3,         // only for USER-driven transitions
    "noRemote": true,          // RECOMMENDED for agent-driven plans
    "captureEngine": "cg"      // RECOMMENDED: CoreGraphics, skips the bridge
  },
  "focus": { "app": "Genesis", "windowTitle": "Settings" },
  "actions": [ { "atMs": 500, "do": "ax-press", "q": "Chat", "app": "Genesis" } ]
}
```

A blip hunt is the same object with `"activeFps": 15, "threshold": 0.1` and a `videoOut`.

⚠️ You CANNOT request "exactly N frames". Duration, fps and threshold set a budget, and the
recorder keeps however many frames crossed the threshold. Want fewer tiles? Raise the
threshold, lower the fps, shorten the crop window, or `recrop` afterwards. Impossible values
(a duration that is really milliseconds, a threshold above 100, a zero-size region) come back
as warnings in the result JSON rather than as errors.

### Action rules learned the hard way

- **URL navigation uses the `url` action.** Default `target` is `new-tab`, which never
  clobbers what the user is reading. Pass `target: "active-tab"` only when the active tab is
  known to be yours. NEVER `hotkey cmd,l` plus `type`: user keybindings shadow browser
  shortcuts.
- **`type` must run the linear profile** (the runner does this). The human profile ignores
  `--delay` and types at human speed, which blows every later action's timing.
- **Synthetic input on a non-frontmost app is eaten by click-to-focus**, and focus decays
  mid-recording. The runner re-asserts app focus before every click, type and hotkey, but
  only when it knows the target app. Set `plan.focus` in any plan that clicks. Multi-phase
  timelines re-steer with `{atMs, do: "focus", app}` and `{atMs, do: "focus-stop"}`.
- **`click --coords` accepts negative multi-display coordinates; `move` rejects them.**
- **Scroll success is not visual change.** `ok: true` only means wheel events were injected.
  Target it with `coords` or `app`/`windowTitle`, then read `warnings[]`.
- **Never invent media keys.** The vocabulary is modifiers, a-z, 0-9, space, return, tab,
  escape, delete, arrows and f1-f12. The runner rewrites volume keys to osascript. For
  guaranteed pixel motion use an osascript window move, a `url` action, or a real scroll.
- **Window-relative coordinates.** Add `relativeTo: {app, windowTitle?}` to click, scroll or
  hotkey. Coordinates become offsets from the window's top-left, resolved at fire time, so
  the window may move between authoring and recording without breaking the click. Prefer this
  over absolute coordinates in screen-mode captures.
- **AX actions for native apps.** `ax-set`, `ax-press` and `ax-perform` go through the
  compiled native binary (about 50-200 ms, no bridge). Target with `axId`, `q` (universal
  search, refuses when ambiguous), or specific filters. Elements without an AXIdentifier work
  via `q`, `desc` or `subrole`. `ax-set` and `ax-press` fall back to osascript without the
  binary; `ax-perform` errors.

  ```json
  { "atMs": 500,  "do": "ax-press",   "q": "Chat", "app": "Genesis" },
  { "atMs": 1500, "do": "ax-set",     "q": "auth-email", "value": "alice@example.com", "app": "Genesis" },
  { "atMs": 2500, "do": "ax-perform", "q": "theme-picker", "action": "AXShowMenu", "app": "Genesis" }
  ```

⚠️ Recording plans use the capture API. They do NOT carry `see` snapshot guarantees. Never
embed a `see` token in a plan as if the recorder revalidated it.

## Step 4 — read the result

Top-level capture JSON: `{success, data: {contactSheet: {path, …}, frames: [{path,
timestampMs, changePercent, motionBoxes, …}], stats}, error?}`.

1. Read `data.contactSheet.path`. That is the whole motion in one call.
2. Use `frames[].changePercent` with `timestampMs` to locate the discontinuity. A spike
   between adjacent frames is where it jumped; `motionBoxes` gives the changed region.
3. Open individual full-resolution frames only when a visual change needs closer inspection.

Session output lives in a fresh temp directory per run, auto-cleaned by Peekaboo. Do not
manage that cleanup.

⚠️ Review contact-sheet PNGs, never animated GIFs: vision sees only frame 1 of a GIF. Crops
use frame pixels while window geometry uses screen points, so derive the scale from the
observed frame dimensions rather than assuming a Retina multiplier. One retained frame can be
legitimate for a static screen, but it never proves a requested transition was recorded.

## Troubleshooting

Peekaboo routes permission-bound operations through whichever TCC-granted host app is
running. Check `peekaboo permissions status` and `peekaboo bridge status --verbose`.

- MCP reports Screen Recording "Not Granted" while the app shows full grants → first-boot
  handshake race. Reconnect the MCP server; no TCC change is needed.
- 🛑 **Never run two captures concurrently.** It wedges the bridge socket, and every later
  capture returns a screen-recording permission error that looks exactly like a lost grant.
  Stop the other capture, back off about 10 s, retry.
- **Agent-driven plans: set `capture.noRemote: true` and `captureEngine: "cg"` up front.**
  Local CoreGraphics, no bridge. The runner also self-heals: if recording has not started in
  15 s it kills the attempt's process TREE (killing only the shim pid orphans the recorder),
  settles 2 s, and retries once on the opposite transport.
- **Screen-index numbering is not consistent across Peekaboo surfaces.** Trust
  `peekaboo screen list` and always verify frame 1's content.
- **Give the runner a generous Bash timeout.** Wall time is countdown plus up to 15 s
  start-wait plus a 15 s bypass retry plus duration plus crops plus publish. A default 10 s
  tool timeout kills it and it looks like a mystery failure.
- Missing permission: report the exact responsible process and grant error. Never reinterpret
  it as "no content".
- Failed focus or wrong window: stop before capturing another app. Re-inspect the intended
  target.
- Unsupported flag or plan field: consult the installed help. Never copy syntax from an older
  Peekaboo or from an MCP example.

## Anti-patterns

- Never drive timed actions during a recording through your own tool calls.
- Never use an app shortcut such as `cmd,l` for navigation. Use the `url` action.
- Never produce or feed a `.gif` for review.
- Never attempt a drag-select or an interactive region picker. None exists.
- Never let duration default to 60 s.
- Never merge stdout and stderr, and never pipe the capture command.
- Never treat a single empty-output failure as real. Retry once first.
- Never call `capture` through MCP. Only the CLI has it.
- Never reach for ffmpeg or `screencapture` pipelines. Peekaboo does recording, diff sampling
  and tiling natively.
- Never hand-construct a vitrinka board URL. Relay the server-returned `url`.
- Never retry a mutating plan just because the capture output was empty. Verify the target's
  state first, because some actions may already have completed.
