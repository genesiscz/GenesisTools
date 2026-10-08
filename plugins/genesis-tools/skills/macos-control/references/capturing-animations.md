# Capture and inspect an animation

Use this for a resize, menu transition, spring, cursor gesture or other claim that a still
image cannot establish. Record the target window's content, change the UI during that same
recording, then inspect decoded frames. Keep original movies, raw command results and geometry.
For GenesisTools Swift work, also read the project reference
`.claude/skills/swift/references/recording-animations.md`.

## Observe, select and restore

1. Read the current app PID and exact CG window ID. Inspect title, bounds and display scale.
   Pin a PID when several app faces share a bundle ID. IDs from an earlier launch are not valid
   evidence. Save starting preferences and geometry before changing them.
2. Define the transition, the required observation interval and the restoration steps. For a
   resize, capture both expansion and contraction and verify the same window IDs survive.
   Start from the largest intended compact state when choosing a fixed output size. Keep
   recorders out of CPU A/B measurements because capture itself adds work.
3. Use `mode:"isolated"` with the observed `windowIds`. It captures each selected window through
   ScreenCaptureKit even behind other apps. A `region` recording includes unrelated foreground
   pixels, so it cannot prove isolated content. To inspect the separate cursor overlay, choose
   screen/region deliberately and label that evidence accordingly.
4. Choose an output size large enough for the largest expected state. Movie dimensions remain
   fixed; cropped capture follows the live selected bounds and fits into the output with
   padding. Record the recorder's geometry history as well as the movie. Interpolation beyond
   backing pixels creates no new detail.
5. Restore the starting preferences in cleanup with fresh native observations. A failed toggle
   followed by a second toggle is not proof of restoration. Check the resulting values and
   original window IDs; do not reset settings globally.

## One process owns recording and actions

A capture plan already keeps its recorder child alive, waits for the first retained frame,
and dispatches `actions` on one timeline. Use that native path instead of backgrounding a
screen-recorder shell and returning to model/tool turns for each action. Recorder startup
and human-visible input have different timing; `actualMs` reports dispatch, not presentation.

For example, after observing both the recording window and the exact Settings control:

```json
{
  "capture": {
    "mode": "isolated",
    "windowIds": [12345],
    "canvas": "crop",
    "duration": 18,
    "activeFps": 15,
    "idleFps": 2,
    "threshold": 0,
    "videoOut": "/absolute/path/resize.mp4",
    "indicator": true
  },
  "actions": [
    { "atMs": 1500, "do": "ax-press", "app": "1234", "q": "EXACT OBSERVED CONTROL", "onError": "abort" },
    { "atMs": 6000, "do": "ax-press", "app": "1234", "q": "EXACT OBSERVED CONTROL", "onError": "abort" }
  ]
}
```

These are placeholders, not permission to toggle a setting. Replace the window ID, app PID,
control and output path with fresh authorized targets. Include sufficient initial/final hold
frames and enough time between steps for the motion to finish. The two presses illustrate a
timeline; cleanup must still verify and restore the saved starting state. For exact values,
use the documented `ax-set` action where the control supports it. The capture action's `q`
must match one control. Four Settings checkboxes all named Tasks cannot use `q:"Tasks"`:
use a unique observed AX identifier, or keep the existing snapshot/element-ref actions in
one bounded native orchestration script. Never disambiguate by an invented label or stale index.

```bash
tools control capture /absolute/path/resize-plan.json \
  > /absolute/path/resize-result.json 2> /absolute/path/resize-errors.log
```

Read process exit, top-level `ok`, each action outcome, native capture warnings, kept frames,
and geometry. On interruption the recorder finalizes the movie and removes its border, and
remaining timed actions are skipped. Never replay a mutating plan just because its movie is
missing. Inspect state and recover recording separately.

`control record-plan capture` can generate the capture object with the same selection,
canvas, scale, codec and indicator flags. It emits an empty action list to edit. Existing
`record-plan start/stop` records input commands into a different replay format; it does not
start this movie capture. Capture flags are refused on input start/stop/status.

For several windows, one isolated plan can select them together. For separate top and side
movies, run bounded plans sequentially, restoring state between takes. Do not run multiple
independent capture commands concurrently or leave orphaned recorder children.

## Build contact sheets from the finished movie

The existing video tool supplies contact sheets and full-resolution PNGs; do not create a
second collage implementation:

```bash
tools video probe /absolute/path/resize.mp4 --json

tools video frames /absolute/path/resize.mp4 \
  --fps 2 --frames-per-image 32 --difference 0 \
  --out /absolute/path/evidence --json
```

It returns an immutable generation with sheets, source PNGs and a manifest of requested and
actual decoded timestamps. Available sheet sizes are 1, 4, 8, 16 or 32 frames. An 18-second
movie at 2 FPS has approximately 36 samples, so the 32-frame setting produces a full sheet
and a partial sheet. Exact counts depend on source duration and timestamps. `--difference 0`
keeps every sampled frame; a positive threshold may remove a small animation you need to see.

For the exact 36-tile layouts used to inspect the top and side widget recordings, ffmpeg is
a useful offline layout option. Run these on the finished original movies, not on another
screen recording of their playback:

```bash
ffmpeg -v error -i /absolute/path/Top-ControlledResize.mov \
  -vf "fps=2,scale=600:-1,tile=3x12" -frames:v 1 \
  /absolute/path/Top-ControlledResize-contact.png

ffmpeg -v error -i /absolute/path/Side-ControlledResize.mov \
  -vf "fps=2,scale=90:-1,tile=12x3" -frames:v 1 \
  /absolute/path/Side-ControlledResize-contact.png
```

The first layout makes three columns of wide top-widget frames. The second makes twelve
columns of narrow side-widget frames. These custom sheets have no timestamp labels; retain
the original movies and the toolkit manifest when exact timing matters. A 36-cell tile shows
only its first 36 samples; adjust the grid or use the toolkit's multiple sheets for longer
movies. Sampling at 2 FPS can show states and gross transition continuity, but cannot establish
frame-perfect spring smoothness. Inspect denser samples or the original video for that claim.

For the 30-second Settings chart overview, the successful layout was ten frames, sampled
one every three seconds and arranged in five columns:

```bash
ffmpeg -v error -i /absolute/path/Settings-Chart.mov \
  -vf "fps=1/3,scale=394:-1,tile=5x2" -frames:v 1 \
  /absolute/path/Settings-Chart-contact.png
```

The video tool accepts integer FPS from 1 to 4; this sparse fractional-FPS layout uses ffmpeg
explicitly. A 280 ms transition can fall between 2 FPS overview samples. Extract its interval
at 16–30 FPS or inspect playback when claiming smoothness; callback timing is not compositor FPS.

Open the generated images. Confirm the expected starting state, intermediate sizes, expanded
state, contraction and final state. Then inspect full-resolution frames where text, clipping,
alpha or geometry matters. A generated file or ffprobe dimension is not a visual verdict.
Transparent MOV backgrounds can look black in a player; verify decoded alpha with both an
outside pixel and a selected-window pixel, as described in [video-review.md](video-review.md).

## What the successful widget take established

The top/side controlled-resize experiment used exact window IDs with native window recording,
an 18-second bound, and one orchestration process that retained two simultaneous native recorder
children through completion while dispatching observed AX Settings changes. Do not generalize
that fixture to concurrent toolkit capture commands, whose startup detection is shared. A single
isolated plan with both IDs, or sequential separate takes, follows the toolkit contract. It logged IDs and dimensions and
restored preferences. The recordings were decoded into the 3×12 and 12×3 sheets above and
visually inspected. Keeping recorders and timed changes in the same process eliminated early
child termination and actions that arrived after the recording had ended.

The corresponding evidence files are `2026-10-09-004247-89ade8fa3-Top-ControlledResize.mov`
and `2026-10-09-004247-89ade8fa3-Side-ControlledResize.mov` in the project's Widget screenshot
folder. The later written script is a reproducible structure for that workflow, not a claim
that the Markdown example was executed byte for byte.

That experiment's temporary `screencapture -x -v -V18 -l<observedID>` transport informed the
procedure. New toolkit recordings should use the isolated capture plan above, which adds
explicit canvas/scale/alpha controls, border cleanup and action results. The successful
transport observation is not an instruction to replace native control with Python, AppleScript
or an unrelated UI provider.

See [capture.md](capture.md) for the full recording contract and [native-cli.md](native-cli.md)
for selectors and coordinate spaces.

## Transparent padding, no labels: the verified clean grid

Verified 2026-10-09 01:10 using the isolated recorder on the live top notch (capture code e79bb4eb1,
native Widget build89ade8fa3). The result has25frames in a3×9grid,1920×1350RGBA pixels,
1,405,300fully transparent pixels; corner/padding and both unused cells have alpha0. No timestamp,
frame number, border or desktop annotation is composited into the grid. The native recording indicator
remains enabled on screen and is excluded from the recording by the isolated content filters.

First obtain the exact window ID from a fresh `control window` observation. Then:

```bash
./tools control capture record --window-ids OBSERVED_ID --canvas crop \
  --transparent --codec prores4444 --output-scale 2 --duration 12.5 \
  --active-fps 8 --idle-fps 2 --threshold 0 --video-out /absolute/evidence/top-alpha.mov
ffmpeg -hide_banner -loglevel error -i /absolute/evidence/top-alpha.mov \
  -vf 'fps=2,format=rgba,scale=600:-1:flags=lanczos,pad=640:150:(ow-iw)/2:(oh-ih)/2:color=0x00000000,tile=3x9:padding=0:margin=0:color=0x00000000' \
  -frames:v 1 /absolute/evidence/top-clean-grid.png
```

The known top-notch aspect ratio fits600pixels into a640×150cell. For another window, choose a cell
larger than its scaled height or use `pad=iw+40:ih+48:20:24:color=0x00000000`. Both pad and tile must
explicitly use transparent color; a black background in an image viewer is not evidence of alpha.
`format=rgba` preserves the movie's alpha through composition. This is deterministic frame extraction,
not a generated illustration or an edited screenshot of a different build.

Verify with ffprobe (`pix_fmt=rgba`) and inspect actual decoded alpha samples. In the testedPNG,
pixel(0,0) and padding pixel(10,60) areRGBA(0,0,0,0); the last cell's alpha min/max are0/0.
Inspect the rendered image too. The source movie remains available for closer motion review.

Durable evidence: GenesisTools/GenesisTools.native/Widget/Screenshot/
`2026-10-09-010830-e79bb4eb1-Top-Transparent-Unannotated.{mov,png,receipt.json,capture.json}`.
The receipt retains exact argv, filter, native geometry and alpha checks. User reference imagery was
used only to choose the grid style; every displayed notch frame comes from the new live capture.

## Native plan timing and action reobservation

For an isolated recording, select content with `capture.windowIds` or the documented application selectors.
Put the UI routing target in `focus` or each action's `app`/`relativeTo`, not in unsupported singular
`capture.app`/`capture.windowTitle` fields. Native plans reject AppleScript actions; use observed AX
identifiers or native hotkeys. Retain admission failures as failed attempts rather than app regressions.

An action may dispatch successfully without returning a refreshed snapshot. ComputerUse then invalidates
its remembered rows. Before the next action, observe the same pinned window again and independently
validate PID plus process-launch identity. A forgotten snapshot must neither block a healthy sequence nor
permit a replacement app to receive the next action. The capture regression covers both cases; the live
top-notch plan opened and closed the same window after this repair.

Plan `actualMs` records action start, not the first presented frame after observation and dispatch.
In one take the opening action started at 1208 ms, but its expanded pane appeared around 7 seconds.
Read the whole movie and geometry history before choosing proof frames. A frame at 4 seconds still
showing the compact notch was consistent with that delayed action, not evidence of a broken compositor.

Choose an output canvas large enough for the expanded target's Retina pixels. Metadata distinguishes
capture scale from interpolation; enlarging a compact 44-point rail does not create additional detail.
Keep the exact plan/result, raw movie, build identity and failed attempts beside the unannotated alpha grid.
