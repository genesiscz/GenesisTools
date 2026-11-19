---
name: recorder
description: Record the screen as a movie and edit it with GenesisTools (tools recorder, the REPL's movies toolset, the recorder window), above all agent demo mode, where one call records a script of steps, marks each step, cuts the waiting and captions every step into a finished demo. Use for "record a demo", "make a screen recording of this flow", "record the screen with the camera bubble", "cut the waiting out of this recording", "caption each step", "open the capture picker", "record an area of the screen", or any edit of a recording's edit.json (cut, zoom, camera bubble, export).
---

# Recorder: movies, demos and the camera bubble

`src/recorder/README.md` is the full reference (`tools recorder --readme` prints it). This skill names the modes and
the order to use them in.

## Pick the mode

| Goal | Use |
|---|---|
| A finished demo of a flow you drive | demo mode: `movies.demo({ steps })` in the REPL, `tools recorder demo <script.json>` from a shell |
| The same demo again with other values | a preset: `presets.save(name, …)`, then `presets.run(name, values)` or `tools node-repl preset run` (node-repl skill) |
| Record by hand | Press ⌘7 for the control bar and target picker. |
| Edit an existing recording | `movies.open(id)` in the REPL, or `tools recorder apply <recording> '<ops>'` |
| Edit a movie that was not recorded here (a render, an export, a movie from another app) | `movies.import(path, { title, markers })` in the REPL, or `tools recorder import <movie> --title T --marker 0:12=Label`: a library recording (an APFS clone where the disk can make one, the file untouched) that every call above then takes; a movie the editor does not play (vp9, HEVC tagged hev1, HDR) is refused with a way to convert it. Never write a library folder by hand |

🛑 Before you edit a recording into a cut for someone (effects, privacy, voiceover, music), read
`references/editing-playbook.md` in full: work on a copy, survey first, place effects on screen events, hide text and
not boxes of the screen, check every effect boundary (on `sheet({ source: true, effects: true })`, which draws source
seconds through the edit and marks cut ones), read `check()`'s `summary` lines, and score the cut before you hand it
over. Run an edit script with `tools node-repl run --toolset movies --timeout 600000 --file edit.js > edit.log 2>&1`
(or as a background task) and read `edit.log`; never pipe it into `head` or `tail`, which hold the output until the
end or stop the run early. Its section 2 is the
table of the calls that exist today, one example each; section 3 is the recipe for a privacy-safe cut.

## Editing at a glance

- Run an edit as a script: `tools node-repl run --toolset movies --timeout 600000 --file edit.js`. Always pass
  `--timeout` (milliseconds; 600000 is 10 minutes, `1800000` is 30): a run without it gets the REPL's short default and
  is killed in the middle of the edit. `help("movies")` lists the methods, `describe("movies.Movie.<name>")` prints
  one in full.
- Most ops use source seconds. Layer fields named `startUs` or `endUs` use source microseconds.
  Survey with `m.sheet({ source: true, every: 0.5, from, to })`,
  `m.still({ at, source: true, full: true })`, `m.events()` and `m.findText()`, never with ffmpeg frame numbers.
- `m.apply(ops)` returns `summary` and `changed`. Run `m.check()` before export.
  Run `m.verifyHidden()` after export to check the hidden parts.

## Use the recording control bar

Press ⌘7 to open the full recorder. The widget opens the same bar for a silent recording of up to ten minutes.
In setup, choose Windows, Apps, Displays, Area or Pick a window. Drag a rectangle in Area.
Use Pick a window to click the window itself. In Displays, the full recorder accepts several checked displays.
A choice sets the target. Press Record to start. The full recorder can also start on choice if you turn on that setting.

Hover over a row or use the arrow keys to outline the target. The outline pulses twice and then stays still.
A choice requests a second pulse. The full recorder can clear this pulse when it closes the picker.
Reduce Motion uses a steady outline. Only a choice can bring a background window forward.

The first row contains the target, microphone, system audio, camera, frame rate and recording controls.
The countdown and Starting… phases offer Cancel. The first frame of this take starts the recording clock.
Pause stops capture until Resume. Choosing or cancelling a target preserves a manual pause.
Stop saves the take. In the done phase, use Open in editor, Show in Finder or New recording.
The widget delivers the saved movie to the draft or the shelf.

Select **…** for quality, still rate, Change needed, countdown, cursor and placement.
The other row shows camera size and shape, sound devices and displays.
Use Save as Defaults in setup. During capture, the extra controls include Add marker, Restart and Discard.
An unavailable control gives its reason on hover and through VoiceOver.
A window or app movie has no sound. Use an area or a display in the full recorder for sound.
The movie engine keeps its original audio inputs. A frames take can change a source that it records.
The camera starts with the movie. Equal active and still rates disable Change needed.

In the REPL, attach to the take with `const r = await recorder.attach("LIVE_ID")`.
Get the live ID with `tools recorder list --live --json`.
For a control without a direct recorder command, use this shell function.
Replace `LIVE_ID` with the ID of your take.

```sh
live() {
    tools node-repl run --toolset recorder "const r = await recorder.attach('LIVE_ID'); await r.$1"
}
```

| Control | REPL call | CLI command |
|---|---|---|
| Available controls and reasons | `r.capabilities()` | `live 'capabilities()'` |
| State and time | `r.status()` | `tools recorder status LIVE_ID` |
| Pause or resume | `r.pause()`, `r.resume()` | `tools recorder pause LIVE_ID`, `tools recorder resume LIVE_ID` |
| Stop or retry Stop | `r.stop()` | `tools recorder stop LIVE_ID` |
| Restart or discard | `r.restart()`, `r.discard()` | `live 'restart()'`, `live 'discard()'` |
| Switch target | `r.switchTarget({ window: 42 })` | `live 'switchTarget({ window: 42 })'` |
| Lock to one display | `r.displays.switch(displayId)` | `live 'displays.switch(37)'` |
| List, add or remove displays | `r.displays.list()`, `r.displays.add(displayId)`, `r.displays.remove(displayId)` | `live 'displays.list()'`, `live 'displays.add(37)'`, `live 'displays.remove(37)'` |
| Mute or restore a sound source | `r.audio.mute("mic")`, `r.audio.unmute("mic")`. Use `"system"` for system sound. | `live 'audio.mute("mic")'`, `live 'audio.unmute("mic")'` |
| Read inputs and outputs or select a microphone | `r.audio.list()`, `r.audio.setInput(deviceId)` | `live 'audio.list()'`, `live 'audio.setInput("INPUT_UID")'` |
| Read or change the active and still rates | `r.settings()`, `r.set({ fps: 30, idleFps: 2 })` | `live 'settings()'`, `live 'set({ fps: 30, idleFps: 2 })'` |
| Add a marker | `r.mark("Step 1")` | `tools recorder mark "Step 1" LIVE_ID` |

Use the display IDs from `r.displays.list()` in place of 37. Use an input ID from `r.audio.list()` in place of `INPUT_UID`.
The service forwards `switchTarget` as `target.switch`. It forwards `restart` as `restart` through `recording.call`.

For setup, use `movies.record({ display: 0, audio: ["mic"], camera: true })` or
`tools recorder start --display 0 --audio mic --camera`. A window or app takes the same sound:
`movies.record({ window: [WINDOW_ID], audio: ["system", "mic"], systemAudioScope: "app" })` or
`tools recorder start --window WINDOW_ID --audio system,mic --system-audio-scope app` keeps only that app's sound in
the system track (the default `all` keeps everything the Mac plays). Use `recorder.start({ displays: "all" })` or
`tools recorder start --frames --displays all` for several displays. `--display follow` (REPL `movies.record({ display:
"follow" })`, the bar's "Follow display") records the display in use and follows the pointer and the focus to another
one after half a second; it is also what a start with no target does. The pickers never offer an overlay (a dimmer
over a whole display) as a window.
Countdown and threshold use `countdown` and `threshold` in `movies.record()` or `--countdown` and `--threshold` at start.
To keep the system cursor, use `systemCursor: true` or `--system-cursor`.
Use Standard quality for movies. For frames, High and Max use `maxLongSide` or `--max-long-side` with 3840 or 16384.
Picker feedback, camera appearance, saved defaults and panel layout use the native controls.
For a saved movie, `m.show()` opens the editor and `m.reveal()` opens Finder.
The CLI commands are `tools recorder edit last` and `tools recorder reveal last`.

| Setting | Default | Effect |
|---|---|---|
| `recorder.picker.choiceStarts` | `false` | Start on choice in full recorder setup. The widget always waits for Record. |
| `recorder.picker.pulse` | `hoverAndChoice` | Use `choiceOnly` for selection only. Use `off` to turn off the outline. |
| `recorder.picker.frontChosenWindow` | `true` | Bring a selected background window forward. |
| `recorder.picker.focusLoss` | `stayOpen` | Use `close` to close the picker when it loses focus. |
| `recorder.bar.placement` | `nearTarget` | Use the saved placement from `recording.panelPlacement` if the bar has no setting. |
| `recorder.bar.look` | `dark` | Use `glass` for the bar's earlier look: the system glass and the app's own control style (Settings → Recorder → Recording bar). |
| `recorder.bar.expandedByDefault` | `false` | Start with the extra rows closed. |
| `recorder.bar.startWaitSeconds` | `5` | Show “Still waiting” after this many seconds without a first frame. |
| `recorder.bar.noticeSeconds` | `4` | Clear a temporary notice after this many seconds. A Stop failure keeps its retry action. |
| `recorder.bar.forForeignRecordings` | `false` | Use compact controls for a recording that starts elsewhere. Turn this on to use the full bar for a compatible recording. |
| `recording.confirmsDiscard` | `true` | Ask for confirmation before Restart or Discard on the bar. |

## Sound lanes and picture layers

Open the edit with `const m = await movies.open("last")`. List its lanes with `await m.audioLanes()`.
The Microphone source file has the ID `mic`. The System sound source file has the ID `system`.
These files replace the mixed track in a frames recording.
A movie track has the ID `movie-0`, `movie-1`, and so on.
A voiceover uses its clip ID. The music lane uses `music`.
A mute or volume change applies to the whole lane.

List the layers with `await m.layers()`. This call returns the IDs from bottom to top.
The timeline shows the top layer first. The camera has the ID `camera` when the edit has a camera file.
Each image or video has its own ID. Use the ID from `addLayer` or `layers()` for later changes.

Pass each JSON example as one shell argument, as in `tools recorder apply last '{"op":"audioLane","id":"mic","muted":true}'`.
Use the path to your image for `logo.png`. Replace `l12345678` with its ID from `layers.media` in the CLI result.

| Operation | JSON for the CLI | Movie handle |
|---|---|---|
| Mute the microphone lane | `{"op":"audioLane","id":"mic","muted":true}` | `await m.audioLane("mic", { muted: true })` |
| Add an image above the other layers | `{"op":"layerAdd","kind":"image","file":"logo.png"}` | `const id = await m.addLayer("logo.png", { kind: "image" })` |
| Hide the camera | `{"op":"layer","id":"camera","hidden":true}` | `await m.layer("camera", { hidden: true })` |
| Move the image below the other layers | `{"op":"layerMove","id":"l12345678","to":"bottom"}` | `await m.moveLayer(id, "bottom")` |
| Remove the image | `{"op":"layerRemove","id":"l12345678"}` | `await m.removeLayer(id)` |

To hide the camera, use `layer {id: "camera", hidden: true}`.
The editor refuses to delete the camera. Set `hidden` to `false` to show it again.

## Several displays

A frames recording of two or more displays keeps each display's frames apart. Its proxy movie shows one display per
segment. The editor draws one row per display above the frames: a card where the movie shows that display, a faint slot
where another display shows. Click a slot to show that display there. Drag a switch line to move the switch.
Right-click a row to hide the display from a segment, or to show it in the selected range or from the playhead.

Read the segments back with `await m.displays()` or `tools recorder displays <recording> --json`. The answer lists
each display, each segment and the switch times, in source seconds. Each change below makes the movie again as one
undo step. `await m.undoDisplaySwitch()` and `tools recorder proxy <recording> --undo-switch` take it back.

| Operation | JSON for the CLI | Movie handle |
|---|---|---|
| Show display 2 from 0:10 to 0:20 | `{"op":"switchDisplay","display":2,"from":10,"to":20}` | `await m.switchDisplay({ display: 2, from: 10, to: 20 })` |
| Hide display 2 from 0:12 to 0:16 | `{"op":"hideDisplay","display":2,"from":12,"to":16}` | `await m.hideDisplay(2, 12, 16)` |
| Hide display 2 everywhere | `{"op":"hideDisplay","display":2}` | `await m.hideDisplay(2)` |
| Move the switch at 0:20 to 0:22.5 | `{"op":"moveDisplaySwitch","at":20,"to":22.5}` | `await m.moveDisplaySwitch(20, 22.5)` |

`tools recorder apply` runs these ops before the edit ops of the same call. A movie or a video recording has no
displays to change, and the refusal says so. A follow-display movie keeps no record of its switches yet.

## Demo mode (one call, a finished demo)

1. Write the steps as `{ caption, run, holdSeconds? }`. `run` does the step (a `computer.*` call, a click, a page
   load); the caption is what the viewer reads while it plays; the hold (1 s) keeps the result on screen.
2. Call `await movies.demo({ title, record: { fps: 30, controls: false }, steps })` with the `movies` toolset loaded
   (`tools node-repl mcp --toolset movies,computer,presets`).
3. Read the result: `steps` (each with `startMs`, `runEndMs`, `endMs`), `failed` (steps that threw; the demo went on),
   `exported.path`. Check it with `await demo.movie.sheet({ count: 6 })` before you hand it over.
4. Change it as an ordinary edit (`demo.movie.retime`, `untext`, `undo`), or pass `edit: { cutIdle: false }`,
   `captionPosition: "top"`, `minWaitSeconds`, … on the next run.
5. When it worked, save it as a preset with parameters (the node-repl skill, "Presets").

The waiting that is cut: still, silent stretches while a step's code runs (idle.ts), the time before the first step
and after the last. A step's first moments and its hold are never cut.

## Exclude windows from frames

For frames, `await recorder.start({ excludeWindowIds: [91, 105] })` returns the recording handle and excludes those
CG windows from each display. The CLI equivalent is `tools recorder start --frames --exclude-window-ids 91,105`.

## Camera bubble

The Camera control records a separate movie (`camera.mov`). Drag the preview before or during capture.
The screen movie excludes the preview. The edit's `camera` field controls its position, size, shape and mirror setting.
Each hidden span has a `cameraHide` item on an effect lane. Change it with
`m.camera({ corner: "topLeft", size: 0.2 })`, `m.cameraHide(from, to)` or the ops `camera`, `cameraHide` (with
`lane`), `cameraShow`, `retime` and `moveToLane`. In the editor's Style tab the user drags the bubble on the preview
and sizes it by its grip; that writes the same `camera` op, so an agent reads the result with `m.info()` as usual. From a script, `record: { camera: true }` (or `tools recorder start --camera`) asks for the camera too: the
preview shows while it records unless Settings → Recorder → "Show the camera preview" says otherwise, and the movie
always leaves it out, so the export shows only the bubble the edit draws.

## Rules

- A recording is the person's screen: record only what the task needs, and say where the movie is.
- `movies.record()` waits up to 120 s for the first segment (a fresh checkout compiles ax-tool first). When it gives
  up, the start is cancelled: a recorder that comes later records nothing, and one that had begun its start gets 30 s
  more, then is stopped. Its error says which; there is nothing to clean up.
- A cut preserves the source time of later items.
