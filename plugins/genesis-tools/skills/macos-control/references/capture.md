# Native recording and frame review

Use `tools control capture` for a short transition and inspect the resulting frames. A still
image cannot prove timing, cursor animation or a complete sequence. Keep publishing separate.

## Backend and permissions

The default is `capture.backend:"native"`: ScreenCaptureKit recording plus native control
actions through the shared ComputerUse API. The runner prepares the backend when needed and
fails if native recording cannot start. It does **not** switch to Peekaboo or AppleScript.
Use the supported `tools`/Bun entrypoint rather than launching an unwrapped native binary
with a different permission identity.

`capture.backend:"peekaboo"` explicitly selects the legacy alternative. Its transport flags
`noRemote` and `captureEngine` do not apply to native capture. A native-only/Jev task must not
select that alternative as recovery. Native capture rejects `url`, `osascript`, media-key
scripting and unsupported custom typing/hold timings before executing the plan.

## Inspect the target first

```bash
tools control capture preflight --app APP
tools control capture --help
```

Use current `window.id` from a native observation as `capture.windowId`. AX window indexes and
the recorder's CGWindowList order can differ. Browser windows include transient strips/popups;
inspect title, bounds and the first frame. Never widen a requested exact-window recording to
another app or whole screen merely because the target failed.

| Requested content | Mode |
| --- | --- |
| One app/window's content | `window` with observed `windowId` |
| Cursor overlay and foreground transitions | `region` around observed bounds, or the selected display |
| A named display | `screen` with the preflight's current screen index |

An overlay is a separate window: a content-only window recording may omit it. Use region/screen
capture when the claim concerns cursor feedback, and review it before claiming visibility.
Negative global origins are valid. Region geometry uses global logical points; crop/annotation
geometry uses frame pixels. Derive scale from captured dimensions; monitors can differ.

## One process owns a timed sequence

Do not drive recording actions through separate model/tool turns. Model latency and round trips
can put actions outside the recording. A plan owns the timeline and waits for recording to start.
An action's `actualMs` records when execution started, not when its pixels or cursor appeared.

After observing Calculator's current window ID and ensuring a suitable clear state, replace
`12345` below with that ID. This changes Calculator and requires authorization for that task.
Confirm each `q` matches one current row, including any matching readout/history value; otherwise
use a uniquely observed `axId` or a script that scopes the button role. The native action adapter
observes at execution time; this JSON does not carry a caller's snapshot token.

```json
{
  "capture": {
    "backend": "native", "mode": "window", "app": "com.apple.calculator",
    "windowId": 12345, "duration": 4, "activeFps": 15, "idleFps": 2,
    "threshold": 0.1, "videoOut": "/tmp/calculator-proof.mp4"
  },
  "focus": { "app": "com.apple.calculator" },
  "actions": [
    { "atMs": 700, "do": "ax-press", "app": "com.apple.calculator", "q": "7" },
    { "atMs": 1700, "do": "ax-press", "app": "com.apple.calculator", "q": "8" },
    { "atMs": 2700, "do": "ax-press", "app": "com.apple.calculator", "q": "9" }
  ]
}
```

```bash
GENESIS_CONTROL_CURSOR=on tools control capture plan.json > /tmp/capture-result.json 2> /tmp/capture-errors.log
```

For overlay proof, use `mode:"region"` and `region:"x,y,width,height"` from observed bounds,
with room for the badge. Review that region for unrelated personal UI. A demonstration without
recording can use one `computer-use run` script; not every adaptive action needs a capture plan.

## Duration, sampling and input

- Plan/native `duration` is **seconds**, bounded by the recorder (up to 180). Set it explicitly.
- `activeFps`, `idleFps` and `threshold` control sampling. Subtle motion may need 15 fps and a low
  threshold. You cannot demand an exact number of retained frames.
- MP4 preserves the captured sequence; PNGs are selected by change threshold. Keep video for
  timing investigations and sample it locally if the contact sheet lacks detail.
- Native `type` is at most 256 single-line UTF-16 units; no custom per-character delay. Use
  script/API paste or exact AX set for longer values. Replacement must be explicit.
- Native controls include `ax-set`, `ax-press`, `ax-perform`, click, type, hotkey and scroll.
  `q` must match a unique observed control; ambiguity stops. Never invent IDs.
- Set `focus` for foreground input. Native controls retain app/window/reference checks. A
  recorder cannot make uncertain input safe or prove completion from dispatch alone.
- For URL navigation, use an observed address field in a native script: replace text, verify,
  then press Return only when requested. Native capture rejects the legacy `url` action.

## Crops and review

Timeline crop markers `{atMs,do:"crop",region,label}` and `{atMs,do:"crop-stop"}` select frame-pixel
regions. A target crop can resolve `{app,windowTitle}` at marker time. Start at zero when the
initial state matters; a crop beginning at 100 ms excludes frame zero. Re-cropping old frames
needs their original geometry, not the window's current position. Use ASCII labels if the
local image/font tool does not support the intended text.

The runner returns:

```text
ok, exitCode, warnings, sessionDir,
actions: [{plannedMs, actualMs, ok, stdout, error}],
capture.data: {source, captureEngine, contactSheet, frames, stats, videoOut},
crops, strip, stripReview
```

Read warnings and every action outcome. Check `capture.data.source === "native"` for native-only
work. View `capture.data.contactSheet.path` or bounded `stripReview`, then full-resolution frames
around a transition. Check target content, not only dimensions. GIF viewers may expose only the
first frame and are unsuitable as multi-frame proof.

Each retained frame carries a `reason`: `first` for frame zero and `change` for every later
one. Only retained frames are written, so the policy's reasons for NOT keeping a frame
(`still`, `cap`) never appear in `frames[]`. A short `frames[]` therefore means the threshold
was not crossed, not that the recorder dropped work.

Distinguish dispatch, visible transition and verified task outcome. Feedback can appear after
input; sampled video does not prove compositor presentation before every mutation.

## Failures and cleanup

- 🛑 **Never run two captures at the same time.** Nothing serialises them. On the Peekaboo
  transport this was measured to wedge the bridge socket, after which every later capture
  returned a screen-recording permission error that looked exactly like a revoked grant.
  Stop the other capture, wait about 10 s, retry once. Never read that error as a lost grant
  without first checking whether another capture is running.
- **Give the command a generous tool timeout.** Wall time is the countdown plus the
  start-wait plus the duration plus crops plus publishing. A default 10 s tool timeout kills
  the runner mid-recording, and the result reads as a mystery failure rather than a timeout.
- Separate stdout/stderr. Check process exit and nested outcomes; empty output is not success.
  The runner owns and bounds its child process tree.
- Inspect state after failed input or a recording with interactions. Never replay a mutating
  plan because video is missing or readback failed. A bounded read-only capture retry must not
  repeat already-dispatched actions.
- Modal, stale target, changed pixels, wrong foreground or unknown delivery stops the affected
  sequence. Inspect the blocker; do not suppress the guard.
- Serialize foreground actions. Another user/process can take focus; use coordination and
  fresh verification, not unscoped global keystrokes.
- Report exact permission/build-lock failures. Do not reset grants casually, kill unrelated
  apps or switch runtimes to obtain success.
- Preserve proof files and capture directories another process might own. Sharing uses the
  separately authorized [publishing workflow](vitrinka.md).

The [Peekaboo reference](peekaboo.md) is a dated optional integration, not this native workflow.
