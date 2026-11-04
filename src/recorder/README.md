# tools recorder

Screen recordings with a movie editor. Record the screen, a window or an app with audio and the cursor; then cut,
speed up, zoom, style and export the movie in the recorder window, from the command line, or from an agent's REPL.
All three edit one file, `edit.json`, so each sees the others' changes.

## Commands

```bash
tools recorder start [--audio system,mic] [--title T] [--max-seconds N] [--display I | --window IDS | --app NAME]
                     [--fps N] [--system-cursor] [--no-controls] [--no-indicator] [--open] [--json]
tools recorder stop|pause|resume|status [id]     # the newest live recording, or the id given
tools recorder mark <label> [id]                 # a marker at this moment; the editor and movie.markers() show it
tools recorder markers <recording> [--chapters]  # its markers as JSON with where each plays, or "0:00 Intro" chapter lines
tools recorder rename <recording> <title>        # a new title for the library, the editor window and movies.list()
tools recorder undo <recording>                  # back one step of apply or the REPL (30 steps in <edit>.undo.json)
tools recorder search <text> [--json]            # titles, marker labels and cached transcript lines across the library
tools recorder list [--live] [--limit N] [--json]
tools recorder edit <recording> [--no-focus] [--at T] [--tab NAME]  # the editor window; --at puts the playhead at an
                                                 # OUTPUT time, --tab opens an inspector tab (zoom, clip, hide, text,
                                                 # style, cursor, captions, audio, export)
tools recorder project <recording>               # the edit as JSON (source seconds)
tools recorder apply <recording> '<op or [ops]>' # change the edit; - reads the ops from stdin
tools recorder export <recording> [--format mp4|gif|webm] [--from T] [--to T] [--out FILE] [--json]
tools recorder proxy <recording>                 # proxy.mp4 for a frames-only recording
```

`<recording>` is a library id, `last`, a recording folder, a movie or an `edit.json`.

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

## The edit (`edit.json`, version 1)

Every time is in microseconds of the SOURCE movie, so a cut never moves a zoom.

- `clips`: the kept parts in play order, each with a `speed` (0.25 to 16). A cut is the gap between two clips.
- `redactions` (optional): rectangles of the source picture (`x`, `y`, `width`, `height` 0 to 1 from the top left)
  hidden from `startUs` to `endUs` by `blur`, `pixelate` or `black`, or shown by a `spotlight` (the rest of the picture
  dims, to point at it); drawn before the zoom, so they move with it. An
  optional `label` names what it hides ("API token"). In the editor a hidden part is drawn, moved and sized on the
  preview itself (Hide tab), and moved or trimmed on its own timeline lane.
- `transcript` (optional): `fixes`, the corrected words of a transcript line by its start in source milliseconds
  (`"1800": "the right words"`, `""` hides the line). Kept in the edit, so a new transcription keeps them; captions,
  `transcript()`, `find()` and `movies.search()` read the fixed words. Ops `fixLine` (`from` the line's start) and
  `unfixLine`; `movie.fixLine(at, text)` takes any time inside the line; the editor's Captions tab lists the lines.
- `texts` (optional): lines of text over the picture (a title, a step's name) from `startUs` to `endUs`: `text`,
  `x`/`y` its centre as 0 to 1 of the CANVAS (so it stays put through a zoom; 0.5, 0.12 by default), `size` 0.02 to
  0.15 of the short side (0.055), `style` `plate` or `plain`. Each fades in and out over 0.2 s. Ops `text` and
  `untext`; the editor's Text tab.
- `zooms`: `startUs`, `endUs`, `scale` 1 to 4, `mode` `manual` (a `focusX`/`focusY` point) or `follow` (the cursor),
  `easeInMs`/`easeOutMs` on a (0.16, 1, 0.3, 1) curve.
- `motion` (optional): `blur` 0 to 1 (0.5 when absent) smears the picture along a zoom's pan or change of scale, as a
  camera shutter would (at most 24 px a frame, so text stays readable through a fast ease); 0 keeps every frame sharp. Op `motion {blur}`; the Zoom tab's slider.
- `audio`: `include`, `volume` 0 to 2, `mutedTracks`.
- `export`: `codec` h264 or hevc, `maxHeight` (0 = source), `output`, `format` (absent = mp4).
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
`unzoom {id}`, `redact {from,to,rect:{x,y,width,height},style?}`, `unredact {id}`, `autoZoom {scale?}` (one zoom per group of clicks under 3 s apart; manual zooms stay), `removeIdle
{minSeconds? 2, keepSeconds? 0.3}` (cuts what is still AND silent: ffmpeg's freezedetect, frame gaps and
silencedetect), `volume`, `mute {track,muted?}`, `audio {include}`, `clicks {…}`, `frame {…, enabled?}`, `cursor {…}`,
`normalize {targetLufs? -16}` (measures the unmuted tracks' EBU R128 loudness and sets the volume, at most 200 %),
`motion {blur?}`, `captions {show?,size?,position?}`, `keys {show?,size?,position?,durationMs?}`, `exportSettings {codec?,maxHeight?,output?,format?}`, `reset`. Times are source seconds or `"mm:ss"`. Ops apply in
order to the file as it is now and save once; one failing op saves nothing and names itself.

## Export

The window, the CLI and the REPL export with one renderer (AVFoundation and the hardware encoder), at a constant
60 fps for a screen recording (a film rate stays). H.264 keeps 60 fps up to 2560×1600; above that the size is fitted,
because the H.264 export preset lowers the rate instead (measured: 2880×1798 came out at 30 fps, 3724×2326 at 15).
HEVC keeps the full size. `--from`/`--to` (REPL `export({ from, to })`, the window's I and O) export only the part
that plays between two OUTPUT times; the edit itself stays whole. A GIF (10 fps, at most 960 wide) or WebM is made by ffmpeg from that movie. An export never
overwrites a file: the default name moves on to `-edited-2`, `-3`. The Export tab can also put the file on the
clipboard when done (off by default) and show it in Finder (on).

## The window (GenesisTools.app, recorder part)

`GenesisTools --recorder [--edit P] [--library] [--no-focus]` runs the menu bar item (record, open, the library,
recent recordings, the drawn cursor and shortcut toggles) and the editor and library windows. Headless: `--export P [--out F] --json`, `--still P --at S
--out PNG`, `--snapshot PNG` with `--edit P [--tab T] [--at S]` or `--library`. The editor: an icon rail (Zoom, Clip,
Hide, Style, Audio, Export), the preview, the transport, and a timeline with the zoom lane, a filmstrip, the waveform and the
playhead's split button. Keys: Space, S (split), [ and ] (trim the clip's start or end to the playhead), Z (zoom), I and O (the export part), ⌘Z, ⇧⌘Z, ⌘S, ⌘E, Delete, the arrows, Home, End, Esc.

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
await m.show({ at: 2.5, tab: "text" });     // opens the editor window there, behind the front window
await m.export({ format: "gif" });
await m.polish();                           // removeIdle, autoZoom, normalize, a frame; steps: [{ step, done, note }]
const r = await movies.record({ maxSeconds: 30, audio: ["system"] }); /* … */ const movie = await r.stop();
```

`transcript()` runs `tools transcribe` once and caches the result beside the movie; the first run may ask for the AI
vault key in GenesisTools.app.
