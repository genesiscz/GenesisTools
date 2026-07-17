# Recording — `tools control capture` (short motion, reviewed frame-by-frame)

The recording arm of macos-control. Everything here concerns multi-frame capture; single-shot element control lives in SKILL.md.

## The mental model

`peekaboo capture live` records a short screen video, **diff-samples** it (frames that changed less than `--threshold` % vs the previous kept frame are dropped — an idle screen collapses to 1-2 frames instead of wasting budget), and tiles the kept frames into **one contact-sheet PNG**. Read that single PNG and you see the whole motion in one vision call. Each kept frame also exists as a full-res individual PNG for drill-down.

Two peekaboo surfaces, split matters:

- **CLI** (`/opt/homebrew/bin/peekaboo`, v3.0.0-beta3) — the ONLY surface with `capture live` / `capture video` (multi-frame + contact sheet). The recording step is always a Bash shell-out.
- **MCP** (`mcp__peekaboo__*`, already registered — don't re-register) — single-shot tools only: `image`, `see`, `list`, `permissions`, plus UI automation. Use `list`/`permissions` from MCP when convenient; never expect `capture` there.

Review is inline by default: capture → Read the contact sheet → answer. Fast, private, no network. Vitrinka is opt-in (see `references/vitrinka.md`).

### `tools control` vs peekaboo — which to use

| Need | Use | Why |
|------|-----|-----|
| Screenshot a window | `tools control screenshot --app X --path f.png` | CGWindowList — no bridge, background capture, ~80ms |
| Click/press UI elements | `tools control click/press --app X --q "Save"` | Element-targeted, no coordinates, ~150ms |
| Type text, key combos | `tools control type/hotkey` | CGEvent, ~8ms/char, no bridge |
| Click through panels, fill forms, screenshot each step | `tools control run plan.json` | Sequential plan runner with snapshot/restore, ~100ms/step |
| Record a transition/animation (multi-frame video) | `tools control capture` + `peekaboo capture live` | Only peekaboo does diff-sampled video + contact sheets |
| Scroll content | `peekaboo scroll` | control doesn't have scroll yet |
| Annotate AX elements visually | `peekaboo see --annotate` | Only useful on native apps (zero boxes on web content) |

**Rule of thumb:** if you don't need a multi-frame recording, `tools control` replaces peekaboo entirely — faster, no bridge flakiness, element-targeted.

## Step 1 — parse duration and fps from the request

- "2s" / "2 seconds" → `--duration 2`
- "4fps" → `--active-fps 4`
- **No duration given → default `--duration 3`.** Never fall through to peekaboo's own 60s CLI default. Always pass `--duration` explicitly.
- fps not given → omit `--active-fps` (default 8, max 15). `--idle-fps` defaults to 2; `--threshold` defaults to 2.5 (% change cutoff for keeping a frame — raise for noisy content like video playback, lower to catch subtle motion).

## Step 2 — resolve the capture target (no drag-select exists, ever)

Priority order:

1. **Target window fills (or nearly fills) one display** → `--mode screen --screen-index N`. THE most reliable mode, empirically zero failures. Get N from `peekaboo list screens --json`. Prefer this over window mode whenever the window occupies its own display.
2. **User named an app/window** → `--mode window --app "<Name>"`, optionally `--window-title "<title>"` / `--window-index N`. **Verify what you actually captured** (frame 1 dimensions/content): browser "windows" include invisible 30-64px strips that the AX API even marks `isMainWindow`, and `--window-title` matching against them silently captures a 387×64 popup instead of the real window. Window ids/indexes: `peekaboo window list --app "<Name>" --json`.
3. **Specific area, bounds unknown** → look bounds up, feed into region mode:
   ```bash
   peekaboo list windows --app "Brave Browser" --include-details bounds --json
   ```
   then `--mode region --region "x,y,width,height"`.
   ⚠️ `--item_type application_windows` is the **MCP tool's** vocabulary — the CLI rejects it. CLI syntax is `list windows --app X --include-details bounds`.
   **Sanity-check bounds**: negative coordinates are LEGAL on multi-display setups (display above/left of primary); compare against `peekaboo list screens --json` positions before declaring them junk. Windows on another macOS Space are invisible to single-shot capture — focus the app first, or capture the screen.
4. **Everything else** → `--mode screen` (primary display).

Avoid `--mode frontmost` — it produced both an intermittent bare crash (exit 133, empty stdout AND stderr) and a real bridge error (`PeekabooBridgeErrorEnvelope error 1`, `INTERNAL_SWIFT_ERROR`) in back-to-back tests, while screen/region modes never failed.

There is **no interactive rectangle picker anywhere in this stack** — don't attempt or build one. macOS `screencapture -i` rejects all video flags before any UI appears, and peekaboo `--mode region` hard-errors without an explicit `--region`. The bounds-lookup above IS the substitute for "select an area".

## Step 3 — plain capture (no interactions)

```bash
peekaboo capture live --mode <screen|window|region> \
  [--app "<Name>"] [--region "x,y,width,height"] \
  --duration <seconds> [--active-fps <n>] [--threshold <pct>] \
  --json 1>/tmp/capture-out.json 2>/tmp/capture-err.log
```

Rules that came from real failures:

- **Always `--json`** and parse it; never eyeball plain-text output.
- **Redirect stdout and stderr to SEPARATE files** (`1>out.json 2>err.log`), never merge (`2>&1`) or pipe — a merged redirect occasionally produced a spurious empty-output failure that a clean separated-stream retry did not reproduce.
- **Nonzero exit with empty stdout AND empty stderr → retry the exact same command once** before treating it as a real failure. This pattern recurred and self-resolved on retry both times it was hit.

Threshold tip: when the thing you care about (topbar, toast, small widget) is a small fraction of a large frame, drop `--threshold` to ~1 — at the default 2.5 a topbar-only change on a 3440×1440 screen can be dropped entirely.

**Hunting a sub-second "animation blip"** (stale header, flash of wrong content, double-pop): go `--active-fps 15 --threshold 0.1` — at 8fps/1% a blip inside a ~400ms window leaves only before/after frames, which proves nothing. Then present it as a cropped strip: cut the affected band out of each relevant frame (`magick <frame> -crop WxH+X+Y +repage`) and `-append` them with timestamp labels. Caveat: homebrew imagemagick lacks freetype — `label:` renders via fallback font but garbles non-ASCII; keep labels ASCII.

**Always add `--video-out /tmp/<name>.mp4` on blip hunts.** The MP4 keeps ALL captured frames — the diff filter only prunes the kept-PNG set. Re-sample the exact window from the MP4 without re-recording:

```bash
peekaboo capture video /tmp/<name>.mp4 --start-ms 4800 --end-ms 7000 --every-ms 66 --no-diff --json 1>resample.json 2>resample.err
```

⚠️ **BLUE BUG (beta3, reproduced 2026-07-15):** `capture video … --no-diff` corrupts colors — re-sampled frames come out blue-tinted. Live-kept frames from the SAME recording are fine. Prefer recording at higher `--active-fps` with a low threshold over relying on no-diff re-sampling; still keep `videoOut` (evidence + works once fixed). Layout/timing info in blue frames is still valid, colors are not.

`capture video` also ingests ANY existing recording (QuickTime .mov, simulator recording, a user-sent .mp4) into diff-sampled frames + contact sheet — when the user hands you a video file, this replaces the recording step entirely (same blue-bug caveat for `--no-diff`).

## Step 3b — capture WITH interactions: ALWAYS use the runner

**"With interactions" includes purely STATIC sequences.** "Click through 5 tabs, screenshot each" is still a timed click+capture plan (though for static sequences prefer `tools control run` — see SKILL.md). Hand-driving raw `peekaboo click` + `image` calls has the exact failure modes the runner kills (clicks eaten on unfocused windows, no per-click refocus, no `warnings[]` to tell you a click didn't land).

**An LLM cannot drive timed actions through separate tool calls.** Measured: model thinking + tool round-trips add 3-8s of jitter, so the recording either misses the transition or the action lands before frame 1. Retrying "maybe faster this time" burns tokens and never converges.

The fix is the capture runner: one process owns the whole timeline — starts `capture live`, detects actual recording start (first `keep-0001.png` on disk), then fires each action at its exact planned offset (observed drift: ~1ms).

```bash
tools control capture preflight [--app "Brave Browser"]   # ALWAYS FIRST when writing a plan
tools control capture --help                              # full TS contract of plan/actions
tools control capture plan.json 1>result.json 2>err.log
```

**`preflight` before every plan you write.** It prints screens (index, scaleFactor, framePixels, and `originCG` — the top-left origin in the GLOBAL point space click coords live in), the frontmost (or `--app`-named) app's window bounds in BOTH points and frame pixels, the active browser tab URL, and a suggested plan skeleton. This kills the two classic footguns in one call: guessing scaleFactor (crop regions are frame px = points × scale) and guessing which screen/window is actually active. Preflight separates real windows (h > 50px) from phantom strips (menu bars/titlebars, listed as `phantomStrips`); `pickedWindow` comes from real windows only.

Write a plan JSON (capture spec + `actions: [{atMs, do, ...}]`), run, then parse `result.json` — it contains a **`warnings[]` array (read it first — "actions fired ok but capture kept 1 frame" means your motion never reached recorded pixels)**, per-action `plannedMs` vs `actualMs` (audit timing before trusting frames), plus the full capture JSON. Plan-level extras: `focus: {app, windowTitle?}` brings the target frontmost before recording AND is re-asserted before every click (set it in any plan that clicks), `browser` sets the default app for `url` actions, and `capture.countdownSec` shows "Recording in 3…2…1" before capture for USER-driven transitions (stderr always; the JXA floating panel does NOT render when agent-spawned — relay the countdown to the user yourself). Pointless for fully synthetic plans.

**Declarative crops** — crop markers in the actions timeline: `{atMs, do: "crop", region|target, label?}` … `{atMs, do: "crop-stop"}`. The runner auto-crops every kept frame in each time window, writes labeled crops to `<sessionDir>/crops/`, and stacks them time-ordered into `crops/strip.png`. It ALSO writes **`crops/strip-review.png` (≤1600px longest side) — Read THAT one for vision review**; the full strip is archival/publish material. Region is in FRAME pixels; labels ASCII-only. Instead of a region you can give `target: {app, windowTitle?}` — bounds looked up AT THE MARKER'S atMs (frozen then; later moves not tracked), points→frame px converted automatically (screen-mode captures only). **Overlapping crops** — a sequential `crop` (no `toMs`) opens one window at a time; add `toMs` to make a crop its own standalone `[atMs, toMs]` window, so you can crop two+ regions from the same frames at once. Two traps: a crop marker at `atMs: 100` EXCLUDES frame 1 at t=0 — start markers at 0 unless exclusion is intentional; and **verify the strip's content before presenting it** — if the target window moved displays/Spaces between runs, you get a beautifully labeled strip of the wallpaper.

Beyond record+act the runner also does: **`recrop` mode** (`tools control capture recrop <prior-result.json> <plan.json>`) — re-crop a finished run's frames with new regions/windows, no re-recording (`target` crops don't work here — bounds would be from NOW); **direct vitrinka publish** (see `references/vitrinka.md`); **dead-publish guard** (motion actions fired but ≤1 frame kept → publish refused — fix the plan, don't reach for `vitrinka.force`); raw `osascript` action as escape hatch; per-action **`onError: "continue"|"abort"`**; url/osascript actions report stdout/stderr and peekaboo actions report parsed `--json` payloads.

Action rules learned the hard way:

- **URL navigation: use the `url` action.** Default `target` is **`new-tab`** (`open -a`, never clobbers what the user is reading); pass `target: "active-tab"` ONLY when the active tab is known to be yours. NEVER `hotkey cmd,l` + `type` — user keybindings shadow browser shortcuts.
- **`type` must run `--profile linear`** (runner does) — peekaboo's default `human` profile ignores `--delay` and types at human WPM, blowing every subsequent action's timing.
- **Synthetic input on a non-frontmost app is eaten by macOS click-to-focus** (and focus DECAYS mid-recording). The runner re-asserts app focus (~120ms) before EVERY click/type/hotkey — but only when it knows the target app: **set `plan.focus` in any plan that clicks**. Multi-phase timelines re-steer with `{atMs, do: "focus", app}` / `{atMs, do: "focus-stop"}` markers.
- **`click --coords` accepts negative (multi-display) coordinates; `move` rejects them.**
- **Scroll success ≠ visual change.** `ok: true` only means wheel events were injected at the cursor. Target it: `scroll` takes `coords` or `app`/`windowTitle`. Then check `warnings[]`.
- **Never invent media keys** (`hotkey volumeup` etc. not in peekaboo vocabulary — modifiers/a-z/0-9/space/return/tab/escape/delete/arrows/f1-f12 only). The runner rewrites volumeup/volumedown/mute/unmute to osascript volume. For guaranteed pixel motion use an osascript window move, a `url` action, or scroll on real content.
- **Window-relative coords (`relativeTo`)** — add `relativeTo: {app, windowTitle?}` to click/scroll/hotkey. Coords become offsets from the window's top-left, resolved to global CG points AT FIRE TIME — the window can move between authoring and recording without breaking clicks. Prefer over absolute coords for screen-mode captures. Example: `{"atMs": 500, "do": "click", "coords": {"x": 100, "y": 200}, "relativeTo": {"app": "Genesis"}}`.
- **AX actions for native apps** — `ax-set`, `ax-press`, `ax-perform` interact via the compiled ax-tool binary (~50-200ms, no bridge). Targeting: `axId` (AXIdentifier, exact), `q` (universal search, refuses if ambiguous), or specific filters. Elements WITHOUT AXIdentifier (browser tabs, toolbar buttons) work via `q`/`desc`/`subrole`. Run `tools control preflight --app X` first for addressable elements + plan skeleton. Fuzzy role matching (`button` → `AXButton`); regex via `/pattern/flags`.
    ```json
    { "atMs": 500, "do": "ax-press", "q": "Chat", "app": "Genesis" },
    { "atMs": 1500, "do": "ax-set", "q": "auth-email", "value": "a@b.com", "app": "Genesis" },
    { "atMs": 2500, "do": "ax-perform", "q": "theme-picker", "action": "AXShowMenu", "app": "Genesis" }
    ```

## Step 4 — read the result

Capture JSON top level: `{success, data: {contactSheet: {path, …}, frames: [{path, timestampMs, changePercent, motionBoxes, …}], stats}, error?}`.

1. `Read` `data.contactSheet.path` — whole motion in one call.
2. Use `frames[].changePercent` + `timestampMs` to locate the discontinuity — a spike between adjacent frames is "here's where it jumped"; `motionBoxes` gives the changed region.
3. Drill into specific full-res `frames[].path` PNGs when warranted.

Session output lives under a fresh temp dir per run (`/var/folders/…/peekaboo/capture-sessions/capture-<UUID>/`), auto-cleaned by peekaboo — do not manage cleanup.

## Troubleshooting

peekaboo routes permission-bound operations through whichever TCC-granted GUI host app is running (`Peekaboo.app` → `Claude.app` → `Clawdis.app` → in-process fallback). Check `peekaboo permissions status` / `peekaboo bridge status --verbose`.

- MCP reports Screen Recording "Not Granted" while Peekaboo.app shows full grants → first-boot handshake race; **reconnect the MCP server**, no TCC change needed.
- **Never run two captures concurrently** — wedges the bridge socket; every capture then returns `PERMISSION_ERROR_SCREEN_RECORDING`, looking exactly like a lost grant. Stop the other capture, back off ~10s, retry.
- **Agent-driven plans: set `capture.noRemote: true, captureEngine: "cg"` up front** — local CoreGraphics, no bridge; 4/4 in live testing while bridge-path runs stalled. The runner also self-heals: recording not started within 15s → kills the attempt-1 process TREE (killing just the shim pid orphans the recorder), settles 2s, retries once on the OPPOSITE transport. Failures surface in peekaboo's **stdout JSON error envelope** — stderr usually carries only visualizer noise.
- **Screen-index numbering is NOT consistent across peekaboo surfaces** — trust `list screens` (preflight uses it) and always verify frame 1 content.
- **Give the runner a generous timeout** — wall time = countdown + up to 15s start-wait (+15s bypass retry) + duration + crops + publish. From a default ~10s Bash timeout the runner gets killed and looks like a mystery failure.

Full peekaboo flag tables, JSON schema, targeting semantics, bridge internals: `references/peekaboo.md`. Highlights: `--no-remote --capture-engine cg` bypasses the bridge; `see --annotate` is near-useless on browser windows (zero boxes on web content — use `tools control capture clickmap --app "<Browser>"` for a coordinate grid instead); `capture watch` = alias for `capture live`; max 180s, 800 kept frames, 1440px resolution cap (`--resolution-cap`).

## Anti-patterns

- **Never drive timed actions during a recording via your own tool calls** — 3-8s jitter WILL miss the transition. Always a plan through `tools control capture`.
- **Never `hotkey cmd,l` (or any app shortcut) for navigation** — user keybindings shadow them. Use the `url` action.
- **Never produce or feed a `.gif` for review** — vision sees ONLY frame 1 of an animated GIF. Tiled contact-sheet PNG works in one Read.
- **Never attempt a drag-select / interactive region picker** — none exists. Bounds lookup + `--mode region` is the substitute.
- **Never let duration default to 60s.** Pass `--duration` explicitly; ~3s when unspecified.
- **Never merge stdout/stderr or pipe the capture command.**
- **Never treat a single exit-133-with-empty-output as a real failure.** Retry once first.
- **Never call `capture` via MCP** — only the CLI has it.
- **Don't reach for ffmpeg/screencapture pipelines** — peekaboo does recording + diff sampling + tiling natively.
- **Don't hand-construct vitrinka board URLs** — relay the server-returned `url` field.
