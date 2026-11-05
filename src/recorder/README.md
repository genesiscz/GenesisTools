# tools recorder

Screen recordings with a movie editor. Record the screen, a window or an app with audio and the cursor; then cut,
speed up, zoom, style and export the movie in the recorder window, from the command line, or from an agent's REPL.
All three edit one file, `edit.json`, so each sees the others' changes.

## Commands

```bash
tools recorder start [--audio system,mic] [--title T] [--max-seconds N]
                     [--display I | --window IDS | --app NAME | --region X,Y,W,H]
                     [--fps N] [--idle-fps N] [--threshold PCT] [--camera] [--exclude-window-ids IDS]
                     [--system-cursor] [--no-controls] [--no-indicator] [--open] [--json]
tools recorder demo <script.json | -> [--no-export]  # a finished demo from a JSON script of steps (below)
tools recorder stop|pause|resume|status [id]     # the newest live recording, or the id given
tools recorder mark <label> [id]                 # a marker at this moment; the editor and movie.markers() show it
tools recorder markers <recording> [--chapters]  # its markers as JSON with where each plays, or "0:00 Intro" chapter lines
tools recorder rename <recording> <title>        # a new title for the library, the editor window and movies.list()
tools recorder undo <recording>                  # back one step of apply or the REPL (30 steps in <edit>.undo.json)
tools recorder search <text> [--json]            # titles, marker labels and cached transcript lines across the library
tools recorder sheet <recording> [--count N] [--from T] [--to T] [--at T,T] [--out PNG]  # frames on one labelled PNG
tools recorder list [--live] [--limit N] [--json]
tools recorder edit <recording> [--no-focus] [--at T] [--tab NAME]  # the editor window; --at puts the playhead at an
                                                 # OUTPUT time, --tab opens an inspector tab (zoom, clip, hide, text,
                                                 # style, cursor, captions, audio, export)
tools recorder edit                              # no recording: a list in a terminal, the library window otherwise
tools recorder library                           # the recordings library window; a double-click opens the editor
tools recorder opened [--wait [S]] [--json]      # the recordings the editor shows, ▶ the one in front; --wait
                                                 # blocks until a recording comes to the front and prints its folder
tools recorder project <recording>               # the edit as JSON (source seconds)
tools recorder apply <recording> '<op or [ops]>' # change the edit; - reads the ops from stdin
tools recorder export <recording> [--format mp4|gif|webm] [--from T] [--to T] [--out FILE] [--json]
tools recorder proxy <recording> [--display most-change|ID] [--window S] [--switch FROM-TO=ID]
                                                 # proxy.mp4 for a frames-only recording or a meeting: per 10 s window
                                                 # the display that changed most (default; proxy.json is the plan),
                                                 # or one display; a meeting also gets its transcript as captions
                                                 # with the speakers' names
tools recorder find-screen <recording> <text>    # where a text was on the screen (OCR), at source seconds
tools recorder cut-words <recording> --at T --words "you know" [--dry-run]  # cut words out of the line at T
tools recorder cut-fillers <recording> [--lang cs|sk|en] [--all] [--words a,b] [--dry-run]  # every ehm, hm, um;
                                                 # --all also the fillers that are words (jako, like)
tools recorder subtitles <recording> [--format srt|vtt] [--out F] [--from T --to T]  # the transcript as subtitles
tools recorder finish <recording> <movie> [--from T --to T]  # subtitles + chapters for a movie exported elsewhere
```

`<recording>` is a library id, `last`, a meeting id, a recording folder, a movie or an `edit.json`. Noise reduction on
export is the `denoise` op (`{"op":"denoise","reductionDb":12}`, ffmpeg afftdn on a cached copy under `.denoise/`).

A recording is a folder in `~/.genesis-tools/recordings/library/video-<time>/`: `screen.mp4` (H.264, one audio track
per source), `cursor.jsonl` (`{"t": ms, "x": 0..1, "y": 0..1, "click"?: "left"}` at 60 Hz) and `recording.json`.
The system cursor stays out of the movie: each cursor image goes to `cursor-shapes/<hash>.png` (2x) with its hotspot,
the track row where it changes names it, and the editor draws the cursor again (smoothed, at any size, or hidden).
`--system-cursor` (or the menu's "Draw the Cursor in the Editor" off) keeps it in the picture instead. A shortcut
pressed with ⌘ or ⌃ becomes a `"key": "⌘C"` row for the editor's shortcut overlay; plain typing and ⌥ alone never do,
and macOS sends no key while a password field has secure input on. `--no-shortcuts` (or the menu toggle) keeps none.
Pausing ends a segment, so the paused time is not in the movie; segments of the same shape join by stream copy.
While it runs, the menu bar item and the floating controls (hidden from the capture) control it, and so do
`tools recorder stop` and the REPL.

A `<recording>` is a library id, `last` (the newest), `open` (the one in front in the editor; with one window open,
that one), a recording folder, a movie or an `edit.json`. The editor writes which windows it shows to
`~/.genesis-tools/recordings/editor-open.json` with its pid, so a reader drops the file of an editor that is gone.

## The edit (`edit.json`, version 1)

Every time is in microseconds of the SOURCE movie, so a cut never moves a zoom.

- `clips`: the kept parts in play order, each with a `speed` (0.25 to 16). A cut is the gap between two clips.
- `redactions` (optional): rectangles of the source picture (`x`, `y`, `width`, `height` 0 to 1 from the top left)
  hidden from `startUs` to `endUs` by `blur`, `pixelate` or `black`, or shown by a `spotlight` (the rest of the picture
  dims, to point at it); drawn before the zoom, so they move with it. An
  optional `label` names what it hides ("API token"); `follow: true` moves it with the drawn cursor, centred on it
  (a spotlight on the pointer). In the editor a hidden part is drawn, moved and sized on the
  preview itself (Hide tab), and moved or trimmed on its own timeline lane.
- `transcript` (optional): `fixes`, the corrected words of a transcript line by its start in source milliseconds
  (`"1800": "the right words"`, `""` hides the line). Kept in the edit, so a new transcription keeps them; captions,
  `transcript()`, `find()` and `movies.search()` read the fixed words. Ops `fixLine` (`from` the line's start) and
  `unfixLine`; `movie.fixLine(at, text)` takes any time inside the line, `movie.fixLines([{ at, text }])` many in one
  save and one undo; the editor's Captions tab lists the lines.
- `texts` (optional): lines of text over the picture (a title, a step's name) from `startUs` to `endUs`: `text`,
  `x`/`y` its centre as 0 to 1 of the CANVAS (so it stays put through a zoom; 0.5, 0.12 by default), `size` 0.02 to
  0.15 of the short side (0.055), `style` `plate` or `plain`. Each fades in and out over 0.2 s. Ops `text` and
  `untext`; the editor's Text tab.
- `shapes` (optional): an `arrow` from (`x1`, `y1`) to its head at (`x2`, `y2`), or a `box` or `circle` between those
  corners, over the SOURCE picture (it moves with a zoom) from `startUs` to `endUs`, `color` (#FF3B30) and `width`
  (0.006 of the short side). It draws itself on over 0.3 s and fades out over 0.2 s. Ops `shape {from, to, kind,
  start, end, color?, width?}` and `unshape {id}`; `movie.arrow({ from, to, at })` points at `at`; the Text tab.
- `zooms`: `startUs`, `endUs`, `scale` 1 to 4, `mode` `manual` (a `focusX`/`focusY` point) or `follow` (the cursor),
  `easeInMs`/`easeOutMs` on a (0.16, 1, 0.3, 1) curve.
- `motion` (optional): `blur` 0 to 1 (0.5 when absent) smears the picture along a zoom's pan or change of scale, as a
  camera shutter would (at most 24 px a frame, so text stays readable through a fast ease); 0 keeps every frame sharp. Op `motion {blur}`; the Zoom tab's slider.
- `audio`: `include`, `volume` 0 to 2, `mutedTracks`, `music` (optional): `file` looped under the movie, `volume` 0 to
  1 (0.25), `fadeMs` (1500) at both ends, and `duck` (0.6): while a transcript line plays the music drops by that
  much, with a 0.3 s ramp. Op `music {file?, volume?, duck?, fadeMs?, enabled?}`; the Audio tab's Music section.
- `export`: `codec` h264 or hevc, `maxHeight` (0 = source), `output`, `format` (absent = mp4), `subtitles` (`srt`
  or `vtt`: a subtitle file beside every export, from the cached transcript with its fixes, in the movie's time;
  absent is none; `exportSettings {subtitles: "none"}` stops it), `chapters` (absent is on: an MP4 gets the
  recording's markers as chapters, a part only those inside it; `false` turns it off).
- `clicks` (optional): a disc that grows and fades on each recorded click.
- `frame` (optional): the movie on a background (`none`, `color`, `gradient`, or `image` with `image` a picture file
  and `blur` 0 to 1; the Style tab has Desktop Picture and Choose Image…), with `padding`, `cornerRadius` and a
  `shadow`, on a canvas of its own `aspect` (`16:9`, `4:3`, `1:1`, `9:16`; absent is the movie's shape). The canvas's
  short side is the movie's height; sizes are fractions of it. `fit: "cover"` crops the movie to fill the canvas, the
  crop following the cursor (averaged over ±0.7 s); `contain` (absent) shows all of it.
- `keys` (optional): the kept shortcuts on a plate as they were pressed, `show`, `size` 0.05, `position`, `durationMs`
  1200; above a caption on the same edge.
- `captions` (optional): the spoken lines from `<movie>.transcript.json` (made by `movie.transcript()` or the Style
  tab's Transcribe) on a dark plate, `show`, `size` (text height, 0.038 of the short side), `position` bottom or top.
  Their times are source times, so they follow every cut.
- `cursor` (optional, a movie without the system cursor): `show`, `size` 0.5 to 3, `smoothing` 0 to 1 (the path
  averaged over up to ±120 ms, narrower near a click so the cursor sits on it), `hideAfterMs` (fade out after
  standing still this long; 0 never). Absent is shown, 1, 0.5, 0.

The loader refuses a newer version instead of reading it wrongly. The window watches the file, takes another
process's save as it lands, and keeps the previous version one ⌘Z away.

### Ops (`tools recorder apply`, `movie.apply`)

`split {at}`, `cut {from,to}`, `keep {from,to}`, `speed {from,to,factor}`, `zoom {from,to,scale?,focus?,follow?}`,
`unzoom {id}`, `redact {from,to,rect:{x,y,width,height},style?,label?,follow?}`, `spotlight {from,to,rect,label?,follow?}`, `unredact {id}`, `autoZoom {scale?}` (one zoom per group of clicks under 3 s apart; manual zooms stay), `removeIdle
{minSeconds? 2, keepSeconds? 0.3}` (cuts what is still AND silent: ffmpeg's freezedetect, frame gaps and
silencedetect), `volume`, `mute {track,muted?}`, `audio {include}`, `clicks {…}`, `frame {…, enabled?}`, `cursor {…}`,
`normalize {targetLufs? -16}` (measures the unmuted tracks' EBU R128 loudness and sets the volume, at most 200 %),
`motion {blur?}`, `captions {show?,size?,position?}`, `keys {show?,size?,position?,durationMs?}`, `exportSettings {codec?,maxHeight?,output?,format?}`, `retime {id, at? | by? | from?, to?}` (moves a zoom, hidden part, text or shape to start `at` or `by` seconds with its length kept, or sets its start or end, which changes the length; a zoom may not meet another zoom), `reset`. Times are source seconds or `"mm:ss"`. Ops apply in
order to the file as it is now and save once; one failing op saves nothing and names itself.

`movie.itemsAt(at)` (and `tools recorder items-at <recording> <at>`) says in words what plays at an output time: the
source time, the zoom, the hidden parts, texts and shapes on screen with their ids, and the caption line.

`movie.check()` (and `tools recorder check`) lists what to look at before an export; an issue with a fix carries it
as a REPL call (`fix`) and as edit ops (`action.ops`). `movie.fix()` (and `tools recorder fix`) runs every such fix in one save and
one undo step; the Export tab's Fix All does the same, and its Remove, Lengthen and Move After buttons run one issue's
ops through `tools recorder apply`.

In the editor, texts and shapes are segments on the marks lane (a drag moves one in time, an edge trims it), and
⌥← / ⌥→ move the selected zoom, hidden part, text or shape by 0.1 s (⇧ for a second). [ and ] trim the selected item's
start or end to the playhead; with no item selected they trim the clip under it.

## Export

The window, the CLI and the REPL export with one renderer (AVFoundation and the hardware encoder), at a constant
60 fps for a screen recording (a film rate stays). H.264 keeps 60 fps up to 2560×1600; above that the size is fitted,
because the H.264 export preset lowers the rate instead (measured: 2880×1798 came out at 30 fps, 3724×2326 at 15).
HEVC keeps the full size. `--from`/`--to` (REPL `export({ from, to })`, the window's I and O) export only the part
that plays between two OUTPUT times; the edit itself stays whole. A GIF (10 fps, at most 960 wide) or WebM is made by ffmpeg from that movie. An export never
overwrites a file: the default name moves on to `-edited-2`, `-3`. The Export tab's presets (YouTube: 1080p H.264 with SRT and chapters; Chat: 720p; README GIF; Archive: HEVC at full
size) set those choices in one click. The Export tab can also put the file on the
clipboard when done (off by default) and show it in Finder (on).

## The window (GenesisTools.app, recorder part)

`GenesisTools --recorder [--edit P] [--library] [--no-focus]` runs the menu bar item (record, open, the library,
recent recordings, the drawn cursor and shortcut toggles) and the editor and library windows. Headless: `--export P [--out F] --json`, `--still P --at S
--out PNG [--full]` (`--full`: the export's size), `--sheet P --times S,S,… --out PNG` (frames in rows of three, each labelled), `--snapshot PNG` with `--edit P [--tab T] [--at S]` or `--library`. The editor: an icon rail (Zoom, Clip,
Hide, Style, Audio, Export), the preview, the transport, and a timeline with the zoom lane, a filmstrip, the waveform and the
playhead's split button. Keys: Space, S (split), [ and ] (trim the clip's start or end to the playhead), ⇧⌫ (delete the I to O part), Z (zoom), T (a text), A (an arrow). A dragged zoom, hidden part or clip edge snaps to the playhead, clip edges,
markers and other items within 7 pt, with a yellow guide (View → Snap While Dragging, `recorder.timeline.snap`, on).
Keys also: I and O (the export part), ⌘Z, ⇧⌘Z, ⌘S, ⌘E, Delete, the arrows, Home, End, Esc.

## The capture picker (⌘7)

The recorder's menu bar item and a global shortcut (⌘7 by default) open one panel: what to record (a window, an app, a
display, or "Select an area…" / ⌘4, a rectangle dragged on any display) and the recording's options in the same
panel: countdown (on, 3 s), frame rate (60), the rate while still ("Same"), the change needed to leave it (0.5 %),
system audio, microphone, the drawn cursor, the shortcuts overlay and the camera bubble. A choice runs `tools
recorder start` with those flags, the one start path the menu uses too. The panel's Shortcuts section rebinds or
turns off each global shortcut: open the picker (⌘7), start with the picker's options without it (⌥⌘7), stop (⌥⌘8),
pause or resume (⌥⌘9) and mark (⌥⌘0). Stop, pause and mark hold their keys only while a recording runs, unless "Hold
stop, pause and mark keys" is on. `GenesisTools --recorder --picker` opens it; with `--snapshot <png>` (and
`--shortcuts`) it draws the panel over made-up targets.

An area is `--region x,y,width,height` in global screen points from the top-left corner (CoreGraphics), recorded in
ax-tool's region mode. `--idle-fps` and `--threshold` reach the capture; without them a movie keeps one rate.

## Camera bubble

With "Camera bubble" on, a live preview of the camera floats where the bubble will be (Small, Medium or Large; circle,
rounded or square); drag it before or while recording. The movie leaves the preview out (`--exclude-window-ids`), and
the recorder face records the camera through GenesisKit's camera (`CameraFrameSource`) into `camera.mov` beside
`screen.mp4`, paused when the recording pauses. At the end it writes `camera.json` (`version`, `file`, `startedAt`,
`screenStartedAt`, `placement: { x, y, size, shape }`), and a new edit takes it as `camera` in `edit.json`:

```json
"camera": { "file": "camera.mov", "offsetMs": 0, "show": true, "corner": "custom", "x": 0.88, "y": 0.82,
            "size": 0.24, "shape": "circle", "mirror": true, "margin": 0.035,
            "hidden": [{ "id": "k1satc", "startUs": 3000000, "endUs": 4000000, "lane": "lane3" }] }
```

`corner` is `bottomRight`, `bottomLeft`, `topRight`, `topLeft` or `custom` (then `x`, `y` are the centre); `size` is
the side over the canvas's short side. Each `hidden` part is a `cameraHide` item on the timeline's effect lanes (a lane
of its own, "Camera Bubble", unless one is added for it), in source times, with its `id` and optional `lane`; an edit
saved before the lanes gets an id from each part's start. Ops: `{"op":"camera", corner?, x?, y?, size?, shape?, mirror?, show?, offsetMs?, file?, enabled?}`,
`{"op":"cameraHide","from":3,"to":4,"lane":"lane3"}`, `{"op":"cameraShow","from":3,"to":3.5}`, and `retime` and
`moveToLane` by the part's id; the REPL has `m.camera({…})`,
`m.cameraHide(from, to)` and `m.cameraShow(from, to)`. The renderer (preview and export) draws it. In the editor, the
Style tab outlines the bubble on the preview (dashed where it is hidden): drag it to move it, drag the grip on its inner
corner to size it, and pick its corner, size, shape and mirror in the tab's "Camera bubble" section. Each of these sends
the same `camera` op (Swift `EditProject.CameraChange`; both sides are tested on
`src/utils/recording-editor/__fixtures__/camera-ops.json`), so `edit.json` is the same from every door, and a drag is
one undo step. `tools recorder
start --camera` asks for the camera without the picker: then the face records it with no preview on screen, because
nothing would keep the preview out of the movie.

## Demo mode: one call, a finished demo

An agent writes the steps; the recorder records them, marks each step, cuts the waiting and captions every step:

```js
const demo = await movies.demo({
    title: "Dark mode in Settings",
    record: { fps: 30, controls: false },
    steps: [
        { caption: "Open System Settings", run: () => computer.launch_app({ bundle_id: "com.apple.systempreferences" }) },
        { caption: "Choose Appearance", run: async () => { /* clicks */ }, holdSeconds: 1.5 },
        { caption: "Pick Dark", run: async () => { /* clicks */ } },
    ],
});
// { movie, folder, steps: [{ caption, startMs, runEndMs, endMs }], failed, ops, sourceSeconds, exported: { path } }
```

Each step gets a marker at its start, runs, then holds for `holdSeconds` (1) so its result stays on screen. Afterwards
the edit cuts the still, silent stretches while a step's code ran (idle.ts; the step's first moments and its hold are
never cut), the time before the first and after the last step, adds a caption per step while it plays, and exports.
A step that throws is listed in `failed` and the next one runs; the recording always stops. `edit` takes `cutIdle`,
`idleMinSeconds` (1), `cutWaits`, `minWaitSeconds` (0.8), `keepSeconds` (0.3), `leadSeconds` (0.5), `tailSeconds` (1),
`captions`, `captionPosition` (`bottom` | `top`), `captionMinSeconds` (1.8) and `markers`. The planner is pure
(`demoEditOps` in lib/demo.ts), so the result stays an ordinary edit: undo, retime or export it again.

The CLI door takes JSON steps that run a `tools` command, a shell line or a wait:

```json
{ "title": "Reload check", "record": { "fps": 30, "controls": false },
  "steps": [{ "caption": "Reload the page", "tools": ["control", "key", "cmd+r"] },
            { "caption": "Wait for the build", "shell": "sleep 4" },
            { "caption": "Done", "wait": 1 }] }
```

Save a demo that worked as a preset and run it again with other values: `presets.save(…)` in the REPL, `tools
node-repl preset run <name> --param key=value` from a shell (src/node-repl/README.md, "Presets").

## Agents: the `movies` REPL toolset

`tools node-repl mcp --toolset movies` (or `run`). `help("movies")` prints every signature with its ranges.

```js
const [hit] = await movies.search("login");    // titles, markers and cached transcript lines across the library
const m = movies.open("last");
await m.removeIdle();                       // { …, removed: [[4.3, 5.7]] }
const [line] = await m.find("this part is a mistake");
await m.cut(line.from, line.to);
await m.zoom({ from: 3, to: 6, scale: 1.8, follow: true });
await m.frame({ padding: 0.08 });
await m.still(2.5);                         // shows the frame as it will export
await m.sheet({ count: 6 });                // six frames over the whole edit on one picture, each with its time
await m.poster({ at: 4 });                  // that frame at the export's full size: <name>-poster.png
await m.show({ at: 2.5, tab: "text" });     // opens the editor window there, behind the front window
await m.export({ format: "gif" });
await m.polish();                           // removeIdle, autoZoom, normalize, a frame; steps: [{ step, done, note }]
await m.spotlight({ from: 2, to: 6, rect: { x: 0.5, y: 0, width: 0.5, height: 0.5 } });  // dims all but the rect
await m.undo();                             // { undone: ["redact"], stepsLeft, … }
const r = await movies.record({ maxSeconds: 30, audio: ["system"] }); /* … */ const movie = await r.stop();
```

`movies.record()` starts `tools recorder start` in its own process and waits up to 120 s for it to record. The two race
for one start gate (`src/utils/process/start-gate.ts`, on `claimPidFile`): the recorder passes it right before it
records, after ax-tool is built, and the wait closes it when it gives up. A recorder that comes after the close records
nothing and exits 1 ("not recording: the caller … gave up"); one that passed first gets 30 s more to record, and is
stopped by its pid when it does not. The flag is `--start-gate <path>` (hidden; only `movies.record` passes it).

`transcript()` runs `tools transcribe` once and caches the result beside the movie; the first run may ask for the AI
vault key in GenesisTools.app.
