# Recording native animations without desktop noise

Verified 2026-10-09 00:53 on the signed GenesisTools Preview build89ade8fa3. This is the exact
workflow behind the top/side notch movies and their contact sheets. Read
[animation-verification.md](animation-verification.md) for geometry, build identity and timing rules.

## What the successful run produced

- Two simultaneous18second window-only MOVs: top notch and right rail, with their other windows excluded.
- Fresh AX settings toggles during the recording: add/remove the Tasks module, verify state, restore it.
- The same native window IDs before/during/after; top width360↔393pt, side height239↔278pt.
- Contact sheets at2frames/second:36tiles,3columns×12rows for the top;12columns×3rows for the side.
- Build/PID/window receipts and separate native animation-callback logs.

Evidence in the Obsidian vault's GenesisTools/GenesisTools.native/Widget/Screenshot/:
`2026-10-09-004247-89ade8fa3-Top-ControlledResize.mov` and
`2026-10-09-004247-89ade8fa3-Side-ControlledResize.mov`.
The larger Clicky chart demonstration used one30second Settings-window movie and a5×2contact sheet
at one frame every3seconds. Direct mouse dragging moved its viewport23:29→23:07; zoom1→2was checked.

## 1. Identify the process, build and windows

Run from the checkout containing the control implementation you intend to exercise:

```bash
./tools control window --app <exact-pid> --json
./tools control see --app <exact-pid> --window-title 'Widgets · top'
./tools control see --app <exact-pid> --window-title 'Widgets · side 1'
```

Read `window_id`, global logical bounds and actual screenshot pixel dimensions. Several app faces can
share one bundle identifier: app-name selection may choose Widget instead of Settings. Use exact PIDs
and fresh window identity; never reuse the numeric IDs above. A title selector is useful when the
current helper reports a transient top panel ambiguously by its window ID; require one exact match.

For the isolated preview, its bundle contains `Contents/Resources/PreviewBuild.json`: commit, dirty
status, native source digest, build time and unsigned binary hash. Verify the observed process launch
is after that build. A build does not restart a running app. Save those fields with the screenshot.
Do not relabel a running older binary with the current Git HEAD.

Preserve user state before manipulation: selected session, drafts and attachment IDs, active recording,
module arrangement, normalized rail position, and Clicky's selected sound/volume. Ask about concurrent
interaction when a recording shows unrelated hovering or clicks; do not blame the animation blindly.

## 2. Capture selected windows, not the desktop rectangle

The verified macOS fallback is:

```bash
/usr/sbin/screencapture -x -v -V 18 -l<window-id> /absolute/evidence/top.mov
```

- `-x`: suppress capture sound; `-v`: movie; `-V18`: bounded18seconds; `-l`: one observed window.
- The selected window remained visible in the movie even behind an unrelated foreground application.
- `-R<x,y,width,height>` is a desktop-region capture. It records whatever covers that rectangle and
  produced a rejected movie of the wrong application during this session. It is not app isolation.
- The ordinary MOV's empty canvas is not proof of an alpha channel. This fallback is a recording
  recipe, not a transparency guarantee. Verify a compatible codec and decoded alpha for alpha claims.
- Preserve the original-resolution movie. Scaling the contact sheet down is for inspection only.
- Logical100×400points can already contain200×800pixels on Retina. Upscaling a1×capture does not
  recreate2×detail. Record both native scale and output scale in metadata.
- A window-only capture may omit an attached sheet. Inspect the pixels and select that sheet too
  when it is part of the demonstration.

Prefer the first-class isolated `tools control capture record` / capture-plan capabilities when that
version is installed. Read the macos-control plugin's capture/capturing-animations references for its
actual flags; do not invent equivalents or silently fall back from an isolation request to `-R`.

## 3. Keep the recorders and actions in one bounded script

Do not start an orphan recorder then spend several model round trips deciding what to click. A short
movie can finish before the action, and a subprocess can be killed when its tool invocation ends.
Keep its parent alive through `communicate()`/`wait()`, collect the true exit status and inspect stderr.
Start this script through a yielding exec session; the script remains running while the tool returns.

This is the structure used for the two-notch test. Replace the two PIDs and repository/output paths
from fresh observations. The example requires the Settings **Widgets** page and the existing four
Tasks toggles (top, side1, side2, side3); another UI must use its own observed selectors.

```python
import datetime
import json
import pathlib
import subprocess
import time

repo = pathlib.Path('/absolute/GenesisTools-checkout')
scratch = pathlib.Path('/tmp/cc/GenesisTools/<session>/animation-proof')
output = pathlib.Path('/absolute/Obsidian/Widget/Screenshot')
widget_pid = '<observed-widget-pid>'
settings_pid = '<observed-settings-pid>'
commit = '<verified-native-build-sha>'
scratch.mkdir(parents=True, exist_ok=True)
output.mkdir(parents=True, exist_ok=True)
proof = {'nativeCommit': commit, 'samples': []}

def control(*arguments):
    run = subprocess.run([str(repo / 'tools'), 'control', *arguments], cwd=repo,
                         text=True, capture_output=True, timeout=15)
    if run.returncode:
        raise RuntimeError(run.stderr + run.stdout)
    result = json.loads(run.stdout)
    if result.get('ok') is False:
        raise RuntimeError(result)
    return result

def task_value(ordinal):
    state = control('see', '--app', settings_pid, '--window-title', 'Settings', '--no-image')
    rows = [r for r in state['elements']
            if r.get('AXDescription') == 'Tasks' and r['role'] == 'AXCheckBox']
    assert len(rows) == 4
    return state, rows[ordinal]

def set_task(ordinal, enabled):
    state, row = task_value(ordinal)
    wanted = '1' if enabled else '0'
    if row['AXValue'] == wanted:
        return
    control('act', '--app', settings_pid, '--snapshot', state['snapshot'],
            '--element', str(row['index']), '--action', 'press')
    _, after = task_value(ordinal)
    assert after['AXValue'] == wanted
    proof['samples'].append({
        'at': datetime.datetime.now().astimezone().isoformat(),
        'ordinal': ordinal, 'value': wanted,
        'windows': control('window', '--app', widget_pid, '--json')['windows']})

original = [task_value(i)[1]['AXValue'] == '1' for i in (0, 1)]
recorders = []
try:
    # Begin at the largest intended compact frame so a fixed-size recording canvas fits it.
    set_task(0, True)
    set_task(1, True)
    time.sleep(0.5)  # Deliberate settle for this finite demonstration, not a production poll.
    windows = control('window', '--app', widget_pid, '--json')['windows']
    stamp = datetime.datetime.now().astimezone().strftime('%Y-%m-%d-%H%M%S')
    for title, label in [('Widgets · top', 'Top'), ('Widgets · side 1', 'Side')]:
        matching = [w for w in windows if w['title'] == title]
        assert len(matching) == 1
        window = matching[0]
        assert window['width'] < 450 and window['height'] < 350, 'Surface is expanded'
        movie = output / f'{stamp}-{commit}-{label}-ControlledResize.mov'
        process = subprocess.Popen(['/usr/sbin/screencapture', '-x', '-v', '-V', '18',
                                    '-l' + str(window['window_id']), str(movie)],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        recorders.append((process, movie))
    time.sleep(1)
    for enabled in (False, True, False):
        set_task(0, enabled)
        set_task(1, enabled)
        time.sleep(1)
finally:
    # In shared use, restore only fields still equal to the last test write; do not overwrite
    # a concurrent human preference. This fixture runs after the user leaves the UI alone.
    for ordinal, enabled in enumerate(original):
        set_task(ordinal, enabled)
    for process, movie in recorders:
        stdout, stderr = process.communicate(timeout=25)
        proof.setdefault('movies', []).append({
            'path': str(movie), 'exitCode': process.returncode,
            'stderr': stderr.decode(), 'bytes': movie.stat().st_size if movie.exists() else 0})
    (scratch / 'proof.json').write_text(json.dumps(proof, indent=2))
```

Inspect every movie's exit status/byte count. If a tool refuses an input before dispatch, save that
refusal; it is not a failed app gesture. Direct mouse-drag verification may need supported native
computer use after disambiguating the exact process. Do not remove admission guards to force a pass.

## 4. Generate the same contact sheets

For an18second capture at2samples/second, the following layouts hold36frames:

```bash
ffmpeg -hide_banner -loglevel error -i /absolute/evidence/top.mov \
  -vf 'fps=2,scale=600:-1,tile=3x12' -frames:v 1 /absolute/evidence/top-contact.png
ffmpeg -hide_banner -loglevel error -i /absolute/evidence/side.mov \
  -vf 'fps=2,scale=90:-1,tile=12x3' -frames:v 1 /absolute/evidence/side-contact.png
```

For the30second Settings chart recording:

```bash
ffmpeg -hide_banner -loglevel error -i /absolute/evidence/settings.mov \
  -vf 'fps=1/3,scale=394:-1,tile=5x2' -frames:v 1 /absolute/evidence/settings-contact.png
```

A contact sheet samples the movie. For a280msnotch transition,2fps can miss intermediate failures.
Use the overview to locate the change, then extract that interval at16–30fps or inspect the original
movie. Add timestamps when comparing several transitions; retain the raw movie and exact filter.
Do not stretch aspect ratio. Empty tiles only mean fewer samples than the requested tile capacity.

## 5. Inspect, measure and keep honest evidence

Open the contact sheet with the image viewer and inspect every populated tile: correct window,
expected action actually visible, no overflow, no unrelated desktop, no stale hover/open state.
Review full-resolution transition frames for icon position and text legibility; a tiny overview alone
cannot establish pixel-perfect geometry or smoothness.

The native callback records live in `~/.genesis-tools/logs/app-perf.log`. Filter exact PID and native
window number plus the recording's timestamp interval. `edge.transition` logs elapsed duration,
callback gaps, callback work and interrupted/completed outcome. A measured284–291mscallback sequence
is not the recording'sFPS and is not a compositor-FPS guarantee. Keep recorders outside CPU A/B runs.

Store each deliverable as `<datetime>-<native-commit>-<descriptive-state>.<extension>`. Receipts retain
process launch/build time, PID, native window ID, logical rectangle, pixel size and hash. Rejected
captures stay in private scratch with a reason; never present the closest successful-looking image as
proof of the failed recording. Restore user preferences/drafts, update Requests.md and the single
Implementation.wrapup.md, and publish the clean evidence through the Answer MCP when requested.

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
