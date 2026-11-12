# tools recorder

Screen recordings with a movie editor. Record the screen, a window, an app or an area with system audio, the
microphone, the cursor and a camera bubble; then cut, speed up, zoom, caption, hide private text and export the movie
in the recorder window, from the command line, or from an agent's REPL. All three edit one file, `edit.json`, so each
sees the others' changes.

## Quick start

```bash
tools recorder start --audio system,mic --countdown   # record the screen in use with sound, after a 3 s countdown
tools recorder stop                                   # stop the newest live recording and save it
tools recorder list                                   # the library, newest first, with the short id commands take
tools recorder apply last '{"op":"removeIdle"}'       # cut the still, silent stretches of the newest recording
tools recorder edit last                              # open it in the editor window
tools recorder export last --out ~/Projects/app/demo.mp4  # render the edit to a movie
```

To record by hand, press ⌘7 for the capture picker. To record a scripted demo in one call, see
[Demo mode](#demo-mode-one-call-a-finished-demo).

## Commands

`<recording>` is a library id (the short id `list` prints, or the whole one), `last` (the newest), `open` (the one
in front in the editor; with one window open, that one), a meeting id, a recording folder, a movie or an `edit.json`.
Each command's `--help` names the forms it takes. Every command takes `--json`; where its help says "accepted for
scripts", the answer is the same with or without it.

Two clocks. SOURCE seconds are the recording as recorded: every op takes them, and a cut never moves them. OUTPUT
seconds are the edited movie, what plays after cuts and speed changes: `items-at`, `comment`, `edit --at`,
`export --from/--to`, `subtitles --from/--to`, `still` and `sheet` (without `--source`) and the `range` op take them.
A time is seconds, `m:ss` or `h:mm:ss`.

### Record

```bash
tools recorder start [target] [flags]            # a movie into the library, until stop, Ctrl-C or --max-seconds
tools recorder start --frames [original|jpeg] [flags]  # frames of the displays instead of a movie
tools recorder stop|pause|resume|status [id]     # the newest live recording, or the id given
tools recorder mark <label> [id]                 # a marker at this moment (1 to 80 characters)
tools recorder demo <script.json | -> [--no-export]  # a finished demo from a JSON script of steps
```

`[id]` is a live id or its end (`list --live` prints them), or the library id `start` and `list` print. `stop`,
`pause`, `resume` and `status` answer in JSON with the live id, the library id and the folder (`stop` also with the
movie). `pause` on a paused recording and `resume` on a running one say "already …" and exit 0. `mark` works on a
movie, a frames or a meeting recording; the editor and `movie.markers()` show the marker.

Target flags of `start` (one at most):

| Flag | What it records |
|---|---|
| (none) | the screen in use: it follows the pointer and the focus |
| `--display <index>` | this display only (NSScreen order) |
| `--window <ids>` | these windows (CG window ids, comma separated) |
| `--app <name>` | this app's windows (name, bundle id or pid) |
| `--region <x,y,w,h>` | an area, in global screen points from the top-left corner (CoreGraphics) |

A display that is not connected, or an area off every display, is refused, naming the displays. A window or app
movie has no audio: `--audio` needs `--display` or `--region`. Every target keeps cursor positions and clicks,
including a recording with the cursor hidden. Window clicks outside the selected windows are excluded. Shortcuts
are kept unless `--no-shortcuts` is set. An area is recorded in ax-tool's region mode.

Movie flags of `start`:

| Flag | Default and limits | What it does |
|---|---|---|
| `--audio <sources>` | none | `system`, `mic` or `system,mic`, one track per source |
| `--mic-device <uid>` | needs `--audio mic` | the microphone, an id from `ax-tool audio-devices` |
| `--fps <n>` | 60, 1 to 120 | frames per second while something moves |
| `--idle-fps <n>` | keeps `--fps`, 0.1 to 5 | frames per second while nothing moves |
| `--threshold <percent>` | 0.5, 0 to 100 | how much of the picture must change to leave the idle rate |
| `--countdown [s]` | off; bare is 3, 1 to 10 | count down on screen and on stderr first |
| `--title <text>` | "Screen recording HH:MM" | the title in the library and the menu |
| `--max-seconds <n>` | none, 1 to 14400 | stop after this long |
| `--exclude-window-ids <ids>` | none | leave these windows out of the movie |
| `--camera` | off | record the camera into `camera.mov` ([Camera bubble](#camera-bubble)) |
| `--system-cursor` | off | keep the system cursor for display/area movies; start with the cursor hidden for window/app movies |
| `--no-shortcuts` | keeps them | keep no ⌘/⌃ shortcuts for the keys overlay |
| `--no-indicator` | border on | no red border around what is recorded (never in the movie) |
| `--no-controls` | controls on | do not open the floating controls |
| `--open` | off | open the editor when the recording stops |
| `--json` | off | events and the result as JSON lines on stdout |

Without `--title`, a window, app or area recording is titled after what it records. `--idle-fps` and `--threshold`
reach the capture; without them a movie keeps one rate. The countdown runs after ax-tool is built. ax-tool needs about
a second from its start to the first frame, so the recorder starts as the last second begins, and the last second
stays on screen ("Starting the recording…" past it) until the movie has its first frame, at most 10 s longer. Zero
never shows before the movie records, so the first thing done after it is in the movie. The overlay is kept out of
the movie (its sharing type, and its window id in the excluded windows); a frames recording, which cannot exclude
windows, relies on the sharing type alone. The picker's countdown does the same: it starts `tools recorder start` as
its last second begins and holds that number until the live entry has its first frame (`lastFrameAt`, which a movie
sets at each segment's first frame and every second after it). Escape cancels the picker's countdown until the
recorder starts.

With `--json`, `start` prints these events: `preparing` (the one-time ax-tool build), `countdown` (its seconds,
before it runs), `started` (id, folder, liveId), `warning` (another recording runs), `state`, `error` and `result`.
`--camera` asks the menu bar recorder for the camera: a refusal fails the start, and a missing camera movie exits 1.
A start that records nothing leaves no folder (it goes to the GenesisTools trash) and prints why.

Frames flags of `start` (`--frames` records the frames of the displays, as the REPL's `recorder.start()` does, through
`lib/frames-recording.ts`):

| Flag | What it does |
|---|---|
| `--frames [format]` | `original` (the recorder's files, the default) or `jpeg` |
| `--jpeg-quality <q>` | with `jpeg`: 0.1 to 1 (0.75) |
| `--naming [naming]` | frame names: `elapsed`, `wall-clock` or `absolute` |
| `--flush [when]` | `finish` (all at the stop) or `piece` (each piece's frames land as it ends) |
| `--ocr` | read the text of each kept frame (Vision OCR) |
| `--ocr-languages <list>` | OCR languages in order of preference (`en-US,cs-CZ`); turns OCR on |
| `--ocr-min-chars <n>` | shorter OCR text is stored as no text; turns OCR on |
| `--ocr-sink [sink]` | `sidecar` (`<frame>.ocr.json`) or `jsonl` (`ocr.jsonl`) |
| `--displays <which>` | `all`, `main` (the default) or display ids, comma separated |
| `--max-long-side <px>` | the longest side of a kept frame, 320 to 16384 |
| `--heartbeat <seconds>` | a frame at least this often while nothing changes; 0 is off |
| `--piece-seconds <n>` | the length of one capture piece, 5 to 180 |

`--fps`, `--idle-fps`, `--threshold`, `--audio`, `--mic-device`, `--title`, `--max-seconds`, `--countdown` and
`--json` work in both modes. The flags become `recorder.start()`'s options and its schema checks them, so
`--frames jpeg --flush piece --ocr --ocr-sink jsonl` records the way a meeting does (each piece's JPEGs and
`ocr.jsonl` rows exist while it records). A movie flag with `--frames` (`--region`, `--camera`, `--display`, …) and
a frames flag without it are refused by name. A frames recording takes `--displays`, not `--display`.

### The library

```bash
tools recorder list [--live] [--limit 20]        # local start times, length, outcome, edited, and the short id (newest started first)
tools recorder show|info <recording>             # one recording's row of list --json
tools recorder search <text>                     # titles, marker labels and cached transcript lines (also the meetings' screen recordings)
tools recorder rename <recording> <title>        # a new title, 1 to 120 characters
tools recorder import <movie> [--title T] [--marker TIME=LABEL ...] [--json]  # a movie file as a library recording
tools recorder duplicate <recording> [--title T] [--to FOLDER]  # a copy with its edit (APFS clones, no extra disk)
tools recorder copy <recording> [--gif]          # its movie (the newest export, else its own) to the clipboard as a file
tools recorder reveal <recording> [--meeting]    # its folder in Finder; --meeting its meeting's meeting.json
tools recorder trash <recording...> [--no-aside] # move recordings through the removal policy, in one call
```

`list --json` has the full ids, folders and why a failed recording failed. `list` also shows the meetings' screen
recordings, mixed in by start time with the newest started first. `search` ignores case and accents and
never transcribes. The new title of `rename` shows in the library, the editor window and `movies.list()`.
`duplicate` titles the copy "`<title> (copy)`" in the library (or writes it to a new or empty `--to` folder) and
prints the copy's edit path. `copy --gif` copies a GIF of the edit and exports one when none is current.

`import` makes a library recording of a movie file ([Import a movie](#import-a-movie)). `trash` runs `tools rm`: the
recording goes into the GenesisTools trash, `tools rm trash` lists it, and the printed `tools rm restore <batch>`
puts it back until it drains. (The window's Move to Trash uses Finder's Trash and Put Back instead.) Run by an agent, or for a recording the
policy does not allow, it asks the user: every such recording goes into ONE request they confirm with
`tools rm approve <id>`. `--no-aside` keeps the folders in the library while that request waits. A meeting's screen
recording is refused, and then nothing is moved.

### Look at a recording

```bash
tools recorder project <recording>               # the edit as JSON (source seconds)
tools recorder markers <recording> [--chapters [--output-time]]  # markers with where each plays (null when cut), or "0:00 Intro" lines
tools recorder click-groups <recording> [--gap 3]  # the clicks in groups as autoZoom groups them: count, source seconds, where each plays (movie.clickGroups())
tools recorder items-at <recording> <at>         # what plays at an OUTPUT time, in words
tools recorder check <recording>                 # what to fix before an export and what to look at; changes nothing
tools recorder sheet <recording> \
    [--count 6 | --every S | --at T,T] \
    [--from T] \
    [--to T] \
    [--source] \
    [--columns N] \
    [--out PNG]                    # up to 48 frames on one grid PNG
tools recorder still <recording> [at] [--source] [--full] [--out PNG]  # one frame; --full at the export's size
tools recorder events <recording> [--kinds scene,scroll,still,click,tap] [--taps FILE]  # screen events, source seconds
tools recorder snap <recording> --at S [--kinds K] | --event KIND [--index 1] [--lead S] [--end] [--taps FILE]
tools recorder waits <recording> [--min-seconds 4] [--max-area 0.06]  # typing and waiting stretches to speed up
tools recorder words <recording> [--at T]        # each transcript line's words as cut-words splits and times them
```

`sheet` puts up to 48 frames on one grid PNG, each labelled with its time; `--every 0.5` is a dense survey, and
`--source` reads the recording as recorded at SOURCE seconds (cut parts too, no effects). `still` renders 1080 tall
unless `--full`. Both write to a temporary file without `--out`. `markers --chapters` leaves cut markers out, for a
video description. Its lines are on the exported file's clock:
with an intro card the first line is the card's title and every marker sits after the card. `--output-time` gives the
movie's own times instead. `events` lists scene changes, scrolls, still stretches, clicks, and taps from `--taps` (a JSON
file of `[{ at, x?, y? }]` for a movie without a cursor track). `snap --at` moves a guessed second to the nearest
event; `--event scene --index 3 --lead -0.3` names one (`--index -1` is the last, `--end` a stretch's end).
`waits` proposes a 4x to 8x speed-up per stretch where at most `--max-area` of the picture changes per quarter
second; apply them with the `speedUpWaits` op.

### Edit

```bash
tools recorder apply <recording> '<op or [ops]>'  # change the edit; - reads the ops from stdin
tools recorder undo <recording>                   # back one step of apply, the REPL or the window
tools recorder redo <recording>                   # make the step undo took back again, while nothing changed since
tools recorder fix <recording>                    # every fix check offers, in one save and one undo step
tools recorder replace-words <recording> --find T --replace T [--match-case] [--part-of-word]  # one undo
tools recorder cut-words <recording> --at T --words "you know" [--occurrence N] [--pad-ms 40] [--dry-run]
tools recorder cut-fillers <recording> [--lang cs|sk|en] [--all] [--words a,b] [--pad-ms 40] [--dry-run]
tools recorder transcribe <recording> [--provider P] [--lang CODE] [--refresh]  # the transcript the captions read
```

`transcribe` transcribes what the export plays (every unmuted audio track, mixed on the movie's clock) into
`<movie stem>.transcript.json` beside the movie. It is a paid run unless a transcript is cached; `--refresh`
transcribes again (do so after muting a track), `--provider` and `--lang` pick the provider and the spoken language.
`apply` saves the ops once, in order (the open editor window reloads it); one failing op saves nothing and names
itself, and a wrong or missing field names the right ones. Undo keeps 30 steps in `<edit>.undo.json`, across runs.
`replace-words` fixes a word or phrase in every transcript line (whole words, any case, unless the flags say
otherwise); captions and subtitles show the fixed words. `cut-words` cuts words out of the line spoken at a SOURCE
time: every place that line says them, or with `--occurrence` only the Nth. `cut-fillers` cuts every filler in one
step: `cs` and `sk` (ehm, hm, hmm, eh, em, ee, éé, mhm; `--all` adds jako, jakože for cs and akože, jako for sk),
`en` (um, uh, uhm, erm, er, hmm, hm, mhm; `--all` adds like); by default every language. Run `--all` with
`--dry-run` first: those fillers are real words. `--pad-ms` is kept off each cut's edges.

### Privacy and screen text

```bash
tools recorder private-data <recording> [--names "Alice Example"] [--exclude-fixed]  # emails, tokens, IBANs, ...
tools recorder find-text <recording> [texts...] [--pattern R]... [--line] [--exclude-fixed] [--from S] [--to S]
tools recorder verify-hidden <recording> \
    [--text T]... \
    [--pattern R]... \
    [--private] \
    [--names L] \
    [--every 0.25] \
    [--movie FILE] \
    [--keep-export]
tools recorder find-screen <recording> <text> [--limit 50]  # OCR hits of a frames recording or a meeting
```

`private-data` reads the screen with Vision OCR on this Mac and lists emails, tokens and keys, phone numbers, IBANs
and card numbers (`--names` finds people or company names too); hide them with the `hidePrivate` op. `find-text`
finds every place a text (or a `--pattern` regular expression) shows, tracked through scrolls, several texts in one
scan; `--line` covers the whole OCR line of a match, `--exclude-fixed` leaves out what stays still while the content
scrolls (a toast, a tab bar). Hide them with the `hideText` op. `verify-hidden` exports the edit (or reads `--movie`),
OCRs its frames every `--every` seconds and lists every output moment where a text, a pattern or the private data
(the default) is still readable; it exits 1 on a leak and removes its export unless `--keep-export`.

`find-screen` answers where a text was on the screen, at source seconds until its frame's next one, with the lines'
boxes over the proxy movie. The editor's Find tab (⌘F) lists them, a click goes there, and Hide This Text (or a box's
eye on the preview) blurs them, Mark It draws a box round them, Cut This Moment cuts the frame's time. `--json` (and
the REPL's `findOnScreen`) names those ops per hit for `apply`: `ops.hide[i]` and `ops.mark[i]` for `boxes[i]`,
and `ops.cut`. A movie recording reads its screen text as `findText` does: the first search reads it once with
Vision, which can take minutes.

### Review comments

```bash
tools recorder comment <recording> <at> <text> [--to T] [--author N] [--link URL] [--annotation N] [--source | --export]
tools recorder comment import <recording> <board> [--card ID] [--dry-run]  # a vitrinka board's annotations
tools recorder comments <recording>              # the comments in time order, with where each plays (plays) and where in the export (exportPlays)
tools recorder resolve <recording> <id> [--reopen]  # a comment done (or open again)
tools recorder uncomment <recording> <id>        # remove a comment
```

A comment sits at an OUTPUT time (`--source` takes recording times, `--export` times of the exported file, as its
player shows them with the intro card first) and shows on the editor's timeline;
`comment add <recording> <at> <text>` is the same command. `--link` is the page it came from (a vitrinka
annotation, a board with `--annotation <number>`, a PR). `comment import` puts each annotation on a shot, movie or
step card (or on one `--card`) at the time its text starts with (0:42, 1:02:03, 42s), read on the exported file the board shows (the intro card's
length comes off; a time on a card goes onto the movie, with a note), else at 0:00 with a note. A second import adds nothing. `<board>` is the board's link (a `?card=` link picks that card),
`<workspace>/<slug>` or its slug.

### Export and finish

```bash
tools recorder export <recording> \
    [--format mp4|gif|webm] \
    [--out FILE] \
    [--from T] \
    [--to T] \
    [--subtitles srt|vtt] \
    [--overwrite] \
    [--size WxH]
tools recorder subtitles <recording> [--format srt|vtt] [--out FILE] [--from T --to T] [--output-time]  # the transcript as subtitles
tools recorder finish <recording> <movie> [--from T --to T]  # subtitles and chapters for a movie exported elsewhere
tools recorder proxy <recording> [--display most-change|ID] [--window 10] [--switch FROM-TO=ID]... [--keep-plan]
tools recorder proxy <recording> --plan <file>   # the proxy with exactly that display plan (a copy of a proxy.json)
tools recorder proxy <recording> --undo-switch   # take the last display switch back (--redo-switch makes it again)
```

`export --size` takes `1920x1080`, `1920x` (width) or `x1080` (height). Progress prints on stderr every 10 %; stdout
stays the result. See [Export](#export) for the renderer, the names and the limits. `subtitles` writes the cached
transcript on the export's clock (cut lines left out, fixes kept), beside the movie and named like its export: with an
intro card every cue starts the card's length later. `--output-time` keeps the movie's own times, without the card (a
part never has one).

`proxy` makes `proxy.mp4` for a frames-only recording or a meeting (frames at their times, audio pieces mixed in), so
the editor opens it. Per 10 s window it shows the display that changed most (the default; `proxy.json` is the plan),
or one display. `--switch 10:00-12:30=4` shows a display in a range whatever the policy picks (repeatable);
`--keep-plan` lays the switches over the last plan, as the editor does. `proxy.undo.json` keeps each switch, and the
editor's ⌘Z and the REPL's `undoDisplaySwitch()` take back the same one. A meeting also gets its transcript as
captions with the speakers' names. The picture holds every display that has frames (bars round a smaller one), so a
switch never moves an edit's hidden parts; an edit made on an older proxy is moved onto the new picture once (one undo
step, `fitToProxy`). `edit` makes the proxy by itself for a frames-only recording.

### Windows and the service

```bash
tools recorder edit [recording] [--no-focus] [--at T] [--tab NAME]  # the editor window
tools recorder library [--no-focus]              # the recordings library window; a double-click opens the editor
tools recorder opened [--wait [S]]               # the recordings the editor shows, ▶ the one in front
tools recorder window close [recording] [--window N]  # close its editor window as the close button does
tools recorder serve [--detach] [--status] [--no-idle]  # the recorder service
```

`edit --at` puts the playhead at an OUTPUT time; `--tab` opens an inspector tab: `zoom`, `clip`, `hide`, `text`,
`style`, `cursor`, `captions`, `audio`, `export` or `find`. `edit` with no recording shows a list in a terminal and
opens the library window otherwise. `opened --wait` blocks until a recording comes to the front and prints its folder
(bare: up to 600 s). `window close` takes a recording or a window number from `opened --json`; it is refused (1021)
while the window has a drag not saved yet or an export runs. `serve --detach` starts the service in the background
and prints its `service.json` once it listens; `--status` prints the running one's (exit 1 when none runs).

## Workflows

### Import a movie

`tools recorder import <movie>` (the REPL's `movies.import(path, { title, markers })`) makes a library recording of a
movie that exists already, such as a render, an export or a movie from another app, so the editor and every command
take it like a recording. It writes the folder the recorder writes (`src/recorder/lib/import.ts`):

- `video-<time>-<uuid>/screen.mp4` (or `screen.mov`): an APFS clone of the file, so it takes no disk until one side
  changes. On a disk without clones it is a whole copy. Nothing writes to the file you import.
- `recording.json`, version 1: `settings.kind` `"video"`, `video { file, durationMs, frames, averageFps }`, `outcome`
  `"done"`, no cursor track (`cursor` `"none"`, `shortcuts` false), `importedFrom` (the file's path), and the markers
  in movie time (`markers [{ atMs, label }]`, `markerClock` `"movie"`).
- A movie with sound keeps it: `audio.sources` is `["movie"]`, so the editor plays, exports and transcribes it as it
  does a recording with system audio in its movie. A movie without an audio track lists no source, and `transcript()`
  refuses it.

A marker is `--marker <time>=<label>` (`0:12=Login done`; `{ at, label }` in the REPL, `at` in source seconds or
`m:ss`), with a label of 1 to 80 characters. A marker outside the movie's video is refused: when the sound runs on
past the video, the editor plays only the video's length. A file that is not a movie the editor plays is refused too,
each with its reason, and the import reads the file the way the editor's probe does before it copies anything:

- another extension, a file ffprobe cannot read, a file with no video stream;
- a video codec AVFoundation does not decode (vp9, dnxhd, QuickTime Animation, among others; checked with
  `AVURLAsset` on macOS 27), with an ffmpeg line that converts it to H.264;
- HEVC tagged `hev1` (ffmpeg's libx265 default in an .mp4), with an ffmpeg line that puts it under `hvc1` without
  encoding it again;
- an HDR movie (PQ or HLG, such as an iPhone's HDR video): the editor takes SDR movies only;
- a movie turned by anything but 0, 90, 180 or 270 degrees.

The editor's own probe then reads the copy and refuses a movie over its limits (12 hours, 48 megapixels, 64 GiB). A
refusal makes nothing; when the editor refuses the copy, its folder goes to the GenesisTools trash.

`movies.import()` returns the recording as a `Movie`, as `movies.open()` does, because the next call is an edit; the
CLI prints the folder on stdout and the id on stderr, and `--json` prints `{ id, folder, title, movie, source, seconds,
frames, averageFps, audioTracks, markers }`. `tools recorder trash <id>` removes it again.

### Demo mode: one call, a finished demo

An agent writes the steps; the recorder records them, marks each step, cuts the waiting and captions every step. The
CLI door takes JSON steps that run a `tools` command, a shell line (`zsh -c`) or a wait:

```json
{ "title": "Reload check", "record": { "fps": 30, "controls": false },
  "steps": [{ "caption": "Reload the page", "tools": ["control", "hotkey", "--keys", "cmd,r"] },
            { "caption": "Wait for the build", "shell": "sleep 4" },
            { "caption": "Done", "wait": 1 }] }
```

```bash
tools recorder demo reload-check.json            # record, edit and export
tools recorder demo - --no-export < reload-check.json  # keep the edited recording, export nothing
```

`record` takes the options of `movies.record()` (the flags of `start` in camelCase). A script may also set `edit`,
`settleSeconds`, `holdSeconds` and `export`. A step's `tools` command or shell line may run 5 minutes before the demo
gives up on it and goes on. The REPL's `movies.demo()` runs code steps instead:

```js
const demo = await movies.demo({
    title: "Dark mode in Settings",
    record: { fps: 30, controls: false },
    steps: [
        {
            caption: "Open System Settings",
            run: () => computer.launch_app({ bundle_id: "com.apple.systempreferences" }),
        },
        { caption: "Choose Appearance", run: async () => { /* clicks */ }, holdSeconds: 1.5 },
        { caption: "Pick Dark", run: async () => { /* clicks */ } },
    ],
});
// { movie, folder, steps: [{ caption, startMs, runEndMs, endMs }], failed, ops, sourceSeconds, exported: { path } }
```

Each step gets a marker at its start, runs, then holds for `holdSeconds` (1) so its result stays on screen. Afterwards
the edit cuts the still, silent stretches while a step's code ran (`idle.ts`; the step's first moments and its hold
are never cut), the time before the first and after the last step, adds a caption per step while it plays, and
exports. A step that throws is listed in `failed` and the next one runs; the recording always stops. `edit` takes
`cutIdle`, `idleMinSeconds` (1), `cutWaits`, `minWaitSeconds` (0.8), `keepSeconds` (0.3), `leadSeconds` (0.5),
`tailSeconds` (1), `captions`, `captionPosition` (`bottom` | `top`), `captionMinSeconds` (1.8) and `markers`. `captionMinSeconds` is the least time a caption stays on screen in the
finished demo, so a quick step's caption can still be read: a cut wait after a step starts no earlier than the end of
its caption, and a caption never runs into the next step (a cut of the idle time inside a long step can still shorten
it). The
planner is pure (`demoEditOps` in `lib/demo.ts`), so the result stays an ordinary edit: undo, retime or export it
again. Save a demo that worked as a preset and run it again with other values: `presets.save(…)` in the REPL,
`tools node-repl preset run <name> --param key=value` from a shell ([node-repl](../node-repl/README.md), "Presets").

### The capture picker (⌘7)

The recorder's menu bar item and a global shortcut (⌘7 by default) open one panel: what to record (a window, an app,
a display, or "Select an area…" / ⌘4, a rectangle dragged on any display) and the recording's options in the same
panel: countdown (on, 3 s), frame rate (60), the rate while still ("Same"), the change needed to leave it (0.5 %),
system audio, microphone, the drawn cursor, the shortcuts overlay and the camera bubble. A choice runs
`tools recorder start` with those flags, the one start path the menu uses too.

The panel's Shortcuts section rebinds or turns off each global shortcut: open the picker (⌘7), start with the
picker's options without it (⌥⌘7), stop (⌥⌘8), pause or resume (⌥⌘9) and mark (⌥⌘0). Stop, pause and mark hold
their keys only while a recording runs, unless "Hold stop, pause and mark keys" is on. The shortcuts work in any app
while the recorder's menu bar item runs. `GenesisTools --recorder --picker` opens the picker; with `--no-focus` (or the
service's `window.show { which: "picker", focus: false }`) it comes to the front without taking the keyboard from the
app in front, and its first click takes it.

While a recording runs, the menu bar item and the floating controls (hidden from the capture) control it, and so do
`tools recorder stop` and the REPL.

### Camera bubble

With "Camera bubble" on, a live preview of the camera floats where the bubble will be (Small, Medium or Large;
circle, rounded or square); drag it before or while recording. The movie leaves the preview out
(`--exclude-window-ids`), and the recorder face records the camera through GenesisKit's camera (`CameraFrameSource`)
into `camera.mov` beside `screen.mp4`. The camera movie runs on the wall clock, pauses included. At the end the face
writes `camera.json` (`version`, `file`, `startedAt`, `screenStartedAt`, `clock: "wall"`,
`placement: { x, y, size, shape }`), and the recording lines the camera up with the screen: it writes each kept
segment's first frame and measured length into `recording.json` (`settings.video.spans`) and cuts `camera.mov` to
every span. A single span is cut too: the camera keeps filming during a pause before Stop. Pauses, a capture limit,
rate changes and display switches can leave gaps that the screen movie does not have. After a cut, `camera.json`
counts from the screen's first frame (`clock: "screen"`, offset 0). A cut that fails retains the original movie and
adds `camera-unaligned`. If its uncut original (`.camera-original-*.mov`) cannot be removed, `camera-leftover` names
the file. That uncut file still holds the excluded periods; remove it before sharing the folder. A new edit takes
the aligned movie as `camera` in `edit.json`:

```json
"camera": { "file": "camera.mov", "offsetMs": 0, "show": true, "corner": "custom", "x": 0.88, "y": 0.82,
            "size": 0.24, "shape": "circle", "mirror": true, "margin": 0.035,
            "hidden": [{ "id": "k1satc", "startUs": 3000000, "endUs": 4000000, "lane": "lane3" }] }
```

`corner` is `bottomRight`, `bottomLeft`, `topRight`, `topLeft` or `custom` (then `x`, `y` are the centre); `size` is
the side over the canvas's short side. Each `hidden` part is a `cameraHide` item on the timeline's effect lanes (a
lane of its own, "Camera Bubble", unless one is added for it), in source times, with its `id` and optional `lane`; an
edit saved before the lanes gets an id from each part's start. Ops:
`{"op":"camera", corner?, x?, y?, size?, shape?, mirror?, show?, offsetMs?, file?, enabled?}`,
`{"op":"cameraHide","from":3,"to":4,"lane":"lane3"}`, `{"op":"cameraShow","from":3,"to":3.5}`, and `retime` and
`moveToLane` by the part's id; the REPL has `m.camera({…})`, `m.cameraHide(from, to)` and `m.cameraShow(from, to)`.
The renderer (preview and export) draws it.

In the editor, the Style tab outlines the bubble on the preview (dashed where it is hidden): drag it to move it, drag
the grip on its inner corner to size it, and pick its corner, size, shape and mirror in the tab's "Camera bubble"
section. Each of these sends the same `camera` op (Swift `EditProject.CameraChange`; both sides are tested on
`src/utils/recording-editor/__fixtures__/camera-ops.json`), so `edit.json` is the same from every door, and a drag
is one undo step.

`tools recorder start --camera` asks for the camera without the picker: then the face records it with no preview on
screen, because nothing would keep the preview out of the movie. Only that face writes `camera.mov`, so `--camera`
and `movies.record({ camera: true })` are refused while it does not run (it holds `~/.genesis-tools/hub/recorder.lock`;
`tools recorder library --no-focus` starts it). A recording that asked for the camera and has no `camera.json` 10 s
after it ended gets a warning in `recording.json`, in the result and on stderr (`lib/camera-recorder.ts`).

## How it works

### The recording folder

A movie recording is a folder `~/.genesis-tools/recordings/library/video-<YYYY-MM-DD_HH-MM-SS>-<uuid>/` (a frames
recording's starts with `library-`):

- `screen.mp4`: H.264, one audio track per source.
- `cursor.jsonl`: `{"t": ms, "x": 0..1, "y": 0..1, "click"?: "left"}` at 60 Hz. A shortcut pressed with ⌘ or ⌃
  becomes a `"key": "⌘C"` row for the editor's shortcut overlay; plain typing and ⌥ alone never do, and macOS sends
  no key while a password field has secure input on. `--no-shortcuts` (or the menu toggle) keeps none.
- `cursor-shapes/<hash>.png`: each cursor image (2x) with its hotspot; the track row where the cursor changes names
  it. The system cursor stays out of the movie and the editor draws it again (smoothed, at any size, or hidden).
  `--system-cursor` (or the menu's "Draw the Cursor in the Editor" off) keeps it in the picture instead.
- `recording.json`: the manifest (id, title, start and end, displays, the settings it recorded with, the markers
  set while it ran, warnings).
- `edit.json`: the edit, once something edited it (`<name>.edit.json` beside a plain movie), and `edit.undo.json`.
- `comments.jsonl`: the review comments (`<name>.comments.jsonl` beside a plain movie).
- `screen.transcript.json`: the cached transcript (`<movie stem>.transcript.json`), made by `movie.transcript()`
  or the editor's Transcribe.
- `camera.mov` and `camera.json` when the camera was on; `voiceovers/` for `say()` lines; `.denoise/` for the
  denoised copy an export reads; `proxy.mp4`, `proxy.json` and `proxy.undo.json` for a frames recording.
- Exports land beside the movie, named after the recording's title ([Export](#export)).

Pausing ends a segment, so the paused time is not in the movie; segments of the same shape join by stream copy.

### Where data lives

The root is `~/.genesis-tools` (under `$GENESIS_TOOLS_HOME` when that is set).

| Path | What it holds |
|---|---|
| `recordings/library/<id>/` | the recordings |
| `recordings/live/<id>.json`, `<id>.sock` | one entry and control socket per running recording |
| `recordings/service.sock`, `service.json` | the recorder service while it runs |
| `recordings/editor-open.json` | which windows the editor shows, with its pid |
| `recorder/analysis/<key>/<name>.json` | slow reads of a movie (OCR, motion, scenes), once per movie content |
| `recorder/start-gates/` | the start gates of `movies.record()` and `serve --detach` |
| `hub/recorder.lock` | held while the menu bar recorder (the app's recorder face) runs |
| `meetings/` | meeting recordings, which `proxy`, `find-screen` and the transcript commands take by meeting id |

The editor writes `editor-open.json` with its pid, so a reader drops the file of an editor that is gone. The
analysis cache keys a movie by its size and a hash of three 4 MB slices, so a copy made with `duplicate` or `cp -c`
reads nothing again, and a second reader that asks for the same read while the first one reads waits for it and takes
its answer.

### What it calls and what it needs

- **ax-tool**, the native recorder (`src/control`), records the screen, the audio and the cursor. A fresh checkout
  compiles it once (up to a minute); `start` says so before the silence.
- **GenesisTools.app's recorder part** runs the editor and library windows, the renderer every export uses, the menu
  bar item, the capture picker and the camera. A CLI command that needs it builds it when the installed app lacks it
  ("about a minute"); the REPL refuses instead and names `tools macos permissions build --add-part recorder`.
- **ffmpeg** makes GIF and WebM from the rendered movie, finds still and silent stretches (`freezedetect`,
  `silencedetect`), denoises (`afftdn`), measures loudness and writes chapters.
- **Vision OCR**, on this Mac, reads the screen for `private-data`, `find-text`, `verify-hidden`, `find-screen` and
  `--frames --ocr`.
- **`tools transcribe`** makes the transcript (`tools recorder transcribe` and `movie.transcript()` run it into
  `<movie stem>.transcript.json`); **`tools say`** speaks a voiceover line; **`tools rm`** moves trashed
  recordings; the **vitrinka MCP** (`scrape_board`, read only) feeds `comment import`.
- **macOS grants**: Screen Recording for the capture, Microphone for `--audio mic`, Camera for the bubble.

What costs money: a transcription without a cache is a paid cloud call (and the first one may ask for the AI vault key
in GenesisTools.app), and `say()` speaks through a cloud voice (provider `xai` by default). Recording, editing,
OCR and export run on the Mac.

### Live recordings and the service

While `tools recorder serve` runs, every live recording joins it, so `stop`, `pause`, `resume`, `status`, `mark` and
the REPL's recording handles go through the service's one socket (`recordings.live`, `recording.call`, and
`recordings.changed` to subscribers). Without a service they use the recording's own socket, which stays the whole
time. A recording that loses the service goes on recording and joins the next service that starts.

The service is the one owner of the recordings' edits while it runs, and the way to the app's recorder face (windows,
renders, the camera). A second start finds the first and exits. It exits after 10 minutes with no connection and no
open edit (`--no-idle` keeps it), and when its code changes.

### The edit (`edit.json`, version 1)

Every time is in microseconds of the SOURCE movie, so a cut never moves a zoom.

- `clips`: the kept parts in play order, each with a `speed` (0.25 to 16). A cut is the gap between two clips.
- `zooms`: `startUs`, `endUs`, `scale` 1 to 4 (1.5), `mode` `manual` (a `focusX`/`focusY` point) or `follow` (the
  cursor), `easeInMs`/`easeOutMs` (450) on a (0.16, 1, 0.3, 1) curve, `target` `picture` or `canvas` (the whole
  framed export).
- `motion` (optional): `blur` 0 to 1 (0.5 when absent) smears the picture along a zoom's pan or change of scale, as a
  camera shutter would over one frame of the exported movie (24, 25, 30 or 60 fps; a GIF made from the MP4 keeps the
  MP4 rate's smear), at most about 1 % of the picture's width a frame, so text stays readable through a fast ease; 0
  keeps every frame sharp. Op `motion {blur}`; the Zoom tab's slider.
- `redactions` (optional): rectangles of the source picture (`x`, `y`, `width`, `height` 0 to 1 from the top left)
  hidden from `startUs` to `endUs` by `blur`, `pixelate` (`cell`, the block in source pixels) or `black`, or shown by
  a `spotlight` (the rest dims by `dim`, 0.5; `dimAround` softens the edge; `cutout` rounded, rect or circle). They
  are drawn before the zoom, so they move with it. An optional `label` names what it hides ("API token");
  `follow: true` moves it with the drawn cursor, centred on it (a spotlight on the pointer). `exclude` areas stay
  visible; a part made by `hideText` or `hidePrivate` carries its `track` and `hide`. In the editor a hidden part is
  drawn, moved and sized on the preview itself (Hide tab), and moved or trimmed on its own timeline lane.
- `redactionJoins` (optional): hidden parts up to `snapMs` (250) apart, or from a cut, meet, so no frame shows between
  them.
- `transcript` (optional): `fixes`, the corrected words of a transcript line by its start in source milliseconds
  (`"1800": "the right words"`, `""` hides the line). Kept in the edit, so a new transcription keeps them; captions,
  `transcript()`, `find()` and `movies.search()` read the fixed words. Ops `fixLine` (`from` the line's start) and
  `unfixLine`; `movie.fixLine(at, text)` takes any time inside the line, `movie.fixLines([{ at, text }])` many in
  one save and one undo; the editor's Captions tab lists the lines. Its scissors per line pick words to cut (the
  `cutWords` op with `occurrence` and the picked words' `from` and `to`, through the recorder service or
  `tools recorder apply`). When the transcript changed since the pick, the times win over the count; a pick whose
  words are no longer there is refused and the words are read again. The scissors also read them again when the
  transcript file was written again or the line fixes changed. Cut Fillers sends `cutFillers` at the level the tab
  sets (`recorder.captions.fillerLevel`: `sounds`, the default, or `all`).
- `markers` (optional): moments marked while editing, `{ id, atUs, label }` at source microseconds, beside the
  recording's own markers in `recording.json`. Op `marker` (`at`, `label`, default "Marker <n>"), op `unmarker`
  (`id`), and the `range` op's action `marker` (at the range's start), which the editor's range popover sends as Add
  Marker. `markers()` and `tools recorder markers` list both kinds (an edit marker with its `id`); the chapters and
  the marks lane show both. An exported MP4's chapters and the burned-in progress bar's dividers fold the same way: a
  marker under 1 s after the chapter kept before it starts none (the earlier name stays), and a first marker under
  1 s starts the first chapter at 0 with no divider (`EMBEDDED_CHAPTER_MIN_SECONDS` in `lib/moments.ts`).
  - A recording's own markers (`settings.markers` in `recording.json`, `{ atMs, label }`) are in movie time: seconds
    of `screen.mp4` from its first frame, with the paused time left out. A mark made before the first frame is at 0
    (at a piece's start after a resume). A movie recording since 2026-11-08 says so with
    `settings.markerClock: "movie"`. An older one has no such key: its markers counted from when the recorder
    reported its first frame, about 1 s later, so they sit up to 1.4 s early. Readers take both as they are.
- `texts` (optional): text over the picture (a title, a step's name) from `startUs` to `endUs`: `text` (up to 500
  characters, several lines), `x`/`y` its centre (the centre of its block) as 0 to 1 of the CANVAS (so it stays put through a zoom; 0.5, 0.12
  by default), `size` 0.02 to 0.15 of the short side (0.055), `style` `plate` or `plain`, `block` (`width` 0.15 to
  0.95, `align`) and `animate`. Without `animate` each fades in and out over 0.2 s. Ops `text` and `untext`; the
  editor's Text tab.
  - `block { width, align }` is the box the text sits in, centred on `x`: `width` is 0.15 to 0.95 of the canvas's
    width (0.8), and the lines wrap at it. `align` (`left`, `center` by default, or `right`) lines up the lines and
    places the text in the box by what shows of it: a `plate` text by its plate, a `plain` text (which draws no
    plate) by its letters. `left` puts that left edge at the block's left edge (`x - width / 2`), `right` puts its
    right edge at the block's right edge (`x + width / 2`), and `center` centres the text on `x`. A plate text keeps
    its plate inside the canvas, a plain text its letters.
  - So texts with the same `x`, block and style line up whatever their lengths and sizes. Example: a title and its
    subtitle at `x` 0.62 with `block: { width: 0.35, align: "left" }` beside a `phone-left` frame both start at 0.445
    of the width.
- `shapes` (optional): an `arrow` from (`x1`, `y1`) to its head at (`x2`, `y2`), or a `box` or `circle` between
  those corners, over the SOURCE picture (it moves with a zoom) from `startUs` to `endUs`, `color` (#FF3B30) and
  `width` (0.006 of the short side). It draws itself on over 0.3 s and fades out over 0.2 s (`appear`: `draw`,
  `fade` or `none`). Ops `shape {from, to, kind, start, end, color?, width?}` and `unshape {id}`;
  `movie.arrow({ from, to, at })` points at `at`; the Text tab.
- `audio`: `include`, `volume` 0 to 2, `mutedTracks`, `music` (optional): `file` looped under the movie (`loop: false`
  plays it once, `startMs` starts inside it), `volume` 0 to 1 (0.25), `fadeMs` (1500) at both ends, and `duck` (0.6):
  while a transcript line plays the music drops by that much, with a 0.3 s ramp. Op
  `music {file?, volume?, duck?, fadeMs?, enabled?}`; the Audio tab's Music section. Also `voiceovers` (sound files
  placed at source times, so they move with cuts), `ducking` (decibels quieter under speech, which replaces `duck`
  once set) and `denoise`.
- `export`: `codec` h264 or hevc, `maxHeight` (0 = source), `output`, `format` (absent = mp4), `subtitles` (`srt`
  or `vtt`: a subtitle file beside every export, from the cached transcript with its fixes, in the movie's time;
  absent is none; `exportSettings {subtitles: "none"}` stops it), `chapters` (absent is on: an MP4 gets the
  recording's markers as chapters; a part gets the chapter current at its start at 0:00 and those inside it, on every
  route; `false` turns it off) and `size` (what `export --size` writes).
- `clicks` (optional): a disc that grows and fades on each recorded click. `radius` is a fraction of the recorded
  picture's height; the disc is drawn on the picture before the zoom and the frame, so it zooms and frames with it.
- `frame` (optional): the movie on a background (`none`, `color`, `gradient`, or `image` with `image` a picture file
  and `blur` 0 to 1; the Style tab has Desktop Picture and Choose Image…), with `padding`, `cornerRadius` and a
  `shadow`, on a canvas of its own `aspect` (`16:9`, `4:3`, `1:1`, `9:16`; absent is the movie's shape). The
  canvas's short side is the movie's height; `padding`, `cornerRadius` and the other sizes are fractions of the
  canvas's short side. `fit: "cover"` crops the movie to fill the
  canvas, the crop following the cursor (averaged over ±0.7 s); `contain` (absent) shows all of it. Presets
  `phone-left`, `phone-right` and `phone-portrait` lay out a phone recording.
- `keys` (optional): the kept shortcuts on a plate as they were pressed, `show`, `size` 0.05, `position`,
  `durationMs` 1200; above a caption on the same edge.
- `captions` (optional): the spoken lines from `<movie>.transcript.json` on a dark plate, `show`, `size` (text
  height, 0.038 of the short side), `position` bottom or top. Their times are source times, so they follow every cut.
  `captionsStyle` animates them.
- `cursor` (optional, a movie without the system cursor): `show`, `size` 0.5 to 3, `smoothing` 0 to 1 (the path
  averaged over up to ±120 ms, narrower near a click so the cursor sits on it), `hideAfterMs` (fade out after
  standing still this long; 0 never). Absent is shown, 1, 0.5, 0. `cursorSmooth` is the smooth cursor.
- Also optional: `camera` ([Camera bubble](#camera-bubble)), `lanes` (the timeline's effect lanes in order),
  `transitions` (at the joins of two clips), `lens` (magnifiers), `tilt` (a 3D tilt of the framed picture),
  `privacy` (what `hidePrivate` hid), `autoSpeed` (the "⏩ 6x" badge over sped-up parts), `progress` (a bar along the
  bottom, divided at the markers), `cards` (an intro and an end card, in the export only), and `revision` and
  `updatedBy`, which every save raises and names.

The loader refuses a newer version instead of reading it wrongly. The window watches the file, takes another
process's save as it lands, and keeps the previous version one ⌘Z away.

### Ops (`tools recorder apply`, `movie.apply`)

Ops apply in order to the file as it is now and save once. Times are source seconds or `"mm:ss"` (the `range` op
takes OUTPUT times). `help("movies")` in the REPL documents each op's fields. The 75 ops by job:

- Time: `split {at}`, `cut {from,to}`, `keep {from,to}`, `speed {from,to,factor}`, `trim`, `deleteClip`,
  `clipSpeed`, `removeIdle {minSeconds? 2, keepSeconds? 0.3, speed?}` (`speed` 2 to 16 plays the still parts faster instead of
  cutting them; otherwise it cuts what is still AND silent: ffmpeg's
  freezedetect, frame gaps and silencedetect), `speedUpWaits {ids?, minSeconds?, maxArea?, speed?}`,
  `reset`.
- Zoom and motion: `zoom {from,to,scale?,focus?,follow?}`, `unzoom {id}`, `setZoom`, `autoZoom {scale?}` (one zoom
  per group of clicks under 3 s apart; a later run replaces only its own zooms, origin "auto", and a canvas zoom does
  not block one), `motion {blur?}`, `lens`, `setLens`, `unlens`, `tilt`,
  `transition`.
- Hide and point: `redact {from,to,rect:{x,y,width,height},style?,label?,follow?}`, `spotlight {from,to,rect,
  label?,follow?}`, `unredact {id}`, `setRedaction`, `redactionJoins`, `hidePrivate`, `hideText`, `unhide`.
- Texts, shapes and marks: `text`, `untext`, `setText`, `shape`, `unshape`, `setShape`, `marker`, `unmarker`,
  `range {from,to,action}` (what the editor's range popover does: cut, keep, speed, zoom, hide, spotlight, text, marker),
  `introCard`, `endCard`, `progress`, `annotateClicks` (circles at the recorded clicks), `removeClickCircles`.
- Items and lanes: `retime {id, at? | by? | from?, to?}` (moves a zoom, hidden part, text or shape to start `at` or
  `by` seconds with its length kept, or sets its start or end, which changes the length; a zoom may not meet another
  zoom), `duplicate` (a copy of an item right after it), `lanes`, `addLane`, `removeLane`, `moveLane`, `moveToLane`,
  `renameLane`.
- Picture: `frame {…, enabled?}`, `cursor {…}`, `cursorSmooth`, `clicks {…}`, `keys {show?,size?,position?,
  durationMs?}`, `camera`, `cameraHide`, `cameraShow`, `autoSpeed` (only the "⏩ 6x" badge over parts that are already sped up).
- Transcript and captions: `fixLine`, `unfixLine`, `cutWords`, `cutFillers`, `captions {show?,size?,position?}`,
  `captionsStyle`.
- Sound: `volume`, `mute {track,muted?}`, `audio {include}`, `music`, `voiceover`, `unvoiceover`, `ducking`,
  `denoise` (`{"op":"denoise","reductionDb":12}`, ffmpeg afftdn on a cached copy under `.denoise/`),
  `normalize {targetLufs? -16}` (measures the unmuted tracks' EBU R128 loudness and sets the volume, at most 200 %).
- Export: `exportSettings {codec?,maxHeight?,output?,format?,subtitles?,chapters?,size?}`.

`movie.itemsAt(at)` (and `tools recorder items-at <recording> <at>`) says in words what plays at an output time, as the
export draws that frame: the source time, the picture zoom and the canvas zoom (or the glide between two linked
zooms), the hidden parts, texts, shapes and lenses on screen with their ids, the caption line (null while captions
are off) and `spoken`, the transcript line said there. A hidden part that `redactionJoins` runs on to a cut or to the
next part counts while it is drawn and carries `drawn: { from, to }`.

`movie.check()` (and `tools recorder check`) lists what to look at before an export: items and markers whose time is
cut, texts a cut shortens, missing music, captions or subtitles without a transcript. An issue with a fix carries it
as a REPL call (`fix`) and as edit ops (`action.ops`). An edit whose cut causes such a loss says so in its own
`warnings`. `movie.fix()` (and `tools recorder fix`) runs every such fix (removes what never shows, moves a cut marker
to the nearest kept moment, lengthens what is too short to read, moves a text off another) in one save and one undo
step; the Export tab's Fix All does the same, and its Remove, Move, Lengthen and Move After buttons run one issue's ops
through `tools recorder apply`.

### Export

The window, the CLI and the REPL export with one renderer (AVFoundation and the hardware encoder), at a constant
60 fps for a screen recording (a film rate stays). H.264 keeps 60 fps up to 2560×1600; above that the size is fitted,
because the H.264 export preset lowers the rate instead (measured 2026-11-04: 2880×1798 and 3456×2160 came out at
30 fps, 3724×2326 at 15). HEVC keeps the full size. `--from`/`--to` (REPL `export({ from, to })`, the window's I and
O) export only the part that plays between two OUTPUT times; the edit itself stays whole. A GIF (10 fps, at most 960
wide) or WebM is made by ffmpeg from that movie.

The default name is the recording's title made safe for a file name, else `<movie>-edited`, beside the source movie.
An export never overwrites a file: the default name moves on to `-2`, `-3`, and an existing `--out` is refused.
`--overwrite` replaces it: the new movie is rendered beside the target and moved over it, so a failed render leaves
the old file. An MP4 gets the markers as chapters, and the subtitle file when the edit asks for one.

The Export tab's presets set those choices in one click: YouTube (1080p H.264 with SRT and chapters), Chat (720p
H.264, no subtitles, no chapters), README GIF (10 fps, at most 960 wide, no sound) and Archive (HEVC at full size with
chapters). The Export tab can also put the file on the clipboard when done (off by default) and show it in Finder
(on).

### The editor window (GenesisTools.app, recorder part)

`GenesisTools --recorder [--edit P] [--library] [--no-focus]` runs the menu bar item (record, open, the library,
recent recordings, the drawn cursor and shortcut toggles) and the editor and library windows. `--picker` opens the
capture picker. Headless: `--export P [--out F] [--size WxH] --json`, `--still P --at S --out PNG [--full]`
(`--full`: the export's size), `--sheet P --times S,S,… --out PNG [--columns N]` (frames on a grid, each labelled),
and `--snapshot PNG` with `--edit P [--tab T] [--at S]`, `--library [--filter TEXT]` or `--picker [--shortcuts]`
(the panel over made-up targets).

The editor: an icon rail of inspector tabs (Zoom, Clip, Hide, Text, Style, Cursor, Captions, Audio, Export, Find),
the preview, the transport, and a timeline with the zoom lane, a filmstrip, the waveform, the effect lanes and the
playhead's split button. Texts and shapes are segments on the marks lane: a drag moves one in time, an edge trims it.
A dragged zoom, hidden part or clip edge snaps to the playhead, clip edges, markers and other items within 7 pt, with
a yellow guide (View → Snap While Dragging, `recorder.timeline.snap`, on; hold ⌘ to place an edge freely).

Keys: Space, S (split), [ and ] (trim the selected item's start or end to the playhead; with no item selected, the
clip under it), ⇧⌫ (delete the I to O part), Z (zoom), T (a text), A (an arrow), I and O (the export part), ⌥← / ⌥→
(move the selected zoom, hidden part, text or shape by 0.1 s, ⇧ for a second), ⌘Z, ⇧⌘Z, ⌘S, ⌘E, ⌘F (Find), Delete,
the arrows, Home, End, Esc.
More keys: J, K and L (play backwards, pause, play faster), B (a box), C (a circle), M (a comment at the playhead),
⌘D (duplicate), ⌥⌘S (save the frame as a picture), ⌥↑ and ⌥↓ (select the previous or next item), ⌘=, ⌘− and ⌘0 (zoom
the timeline in, out, fit), and ⌘1 to ⌘N (show a tab). The editor's menus list them all. Settings > Recording editor >
Single-key shortcuts turns off the keys that have no ⌘ (S, Z, T, A, B, C, I, O, J, K, L and Space).

## Configuration

The recorder has no config file. Its choices live in GenesisTools.app's Settings, under Recorder:

- **Recording**: the capture picker's options (countdown, frame rates, change threshold), what the movie keeps
  (system audio, microphone, the drawn cursor, ⌘ and ⌃ shortcuts), the camera bubble, the global shortcuts with "Hold
  stop, pause and mark keys", and the menu bar item. They apply to the next recording, also one started from the menu
  bar or a shortcut.
- **Recording editor**: the timeline (snap while dragging, a tap when snapping, single-key shortcuts, what a dragged
  range does), what an open editor does when the CLI or an agent changes the edit (a banner, flash the changed items,
  move the playhead), the choices the Clip, Captions and Export tabs keep (`recorder.captions.fillerLevel`, show the
  export in Finder, copy it to the clipboard), and the library's scrub on hover.

`tools recorder start` from a shell does not read these choices: it takes its own flags and their defaults, and
the picker passes its options to it as flags. `GENESIS_TOOLS_HOME` moves every path above.

## For agents

- Every command takes `--json`; `start --json` prints its events as JSON lines. Exit codes: 1 for a failed start, a
  missing camera movie, a failed export, a leak `verify-hidden` found, and `serve --status` with no service; 0 for a
  `pause` or `resume` that was "already" so.
- `stop`, `pause`, `resume` and `mark` without an id act on the NEWEST live recording, which can be another
  session's. Pass the id `start` printed. An unknown subcommand gets a "Did you mean" hint only from the commands
  that change nothing (`status`, `list`, `show`, `search`, `markers`, …), never `stop` or `start`.
- The plugin skill `genesis-tools:recorder` names the modes and their order. Before you edit a recording into a cut for
  someone, read its editing playbook
  ([editing-playbook.md](../../plugins/genesis-tools/skills/recorder/references/editing-playbook.md)):
  work on a copy, survey on the source clock, place effects on screen events, hide text instead of boxes, verify the
  export.

### The `movies` REPL toolset

`tools node-repl mcp --toolset movies` (or `run`). `help("movies")` prints every signature with its ranges, and
`describe("movies.Movie.<name>")` prints one in full. Run a long edit as a script:
`tools node-repl run --toolset movies --file edit.js > edit.log 2>&1` (10 minutes by default with `movies`;
`--timeout <ms>` for more). Never pipe it into `head` or `tail`: the pipe holds every line until the run ends.

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
await m.sheet({ source: true, from: 40, to: 52, every: 0.5 }); // a survey of the recording at SOURCE seconds
await m.poster({ at: 4 });                  // that frame at the export's full size: <name>-poster.png
await m.show({ at: 2.5, tab: "text" });     // opens the editor window there, behind the front window
await m.closeEditor();                      // closes it again: { closed, window }
await m.export({ format: "gif" });
await m.polish();                           // removeIdle, autoZoom, normalize, a frame; steps: [{ step, done, note }]
await m.spotlight({ from: 2, to: 6, rect: { x: 0.5, y: 0, width: 0.5, height: 0.5 } });  // dims all but the rect
await m.undo();                             // { undone: ["redact"], stepsLeft, … }
const r = await movies.record({ maxSeconds: 30, audio: ["system"] }); /* … */ const movie = await r.stop();
const rendered = await movies.import("/path/to/render.mp4", { title: "Tour", markers: [{ at: "0:12", label: "Login" }] });
const area = await movies.record({ region: "0,0,1280,800", idleFps: 1, threshold: 1, countdown: 3 });
```

`movies` has `list`, `search`, `open`, `import`, `record` and `demo`. A `Movie` has one method per op (`cut`, `zoom`, `text`,
`hideText`, …) and the reads and actions of the CLI (`info`, `check`, `fix`, `sheet`, `still`, `itemsAt`, `events`,
`snap`, `waits`, `privateData`, `findText`, `verifyHidden`, `transcript`, `say`, `export`, `subtitles`, `comment`,
`duplicate`, `trash`, …). `movie.trash()` refuses when the removal policy would ask, and asks no one; only
`tools recorder trash`, run as a command, files the request. Every edit call answers `summary` (the edit after it) and
`changed` (what it did). A
`MovieRecording` has `status`, `pause`, `resume`, `mark`, `settings`, `setSettings` and `stop`.

The flags of `start`, their limits and their parse live once in `lib/start-options.ts`: `tools recorder start`
declares them there, and `movies.record()` takes the same options in camelCase (`region`, `idleFps`, `threshold`,
`countdown`, `systemCursor`, `shortcuts`, `micDevice`, `excludeWindowIds`, …), writes them as those flags and runs the
same parse before it starts the CLI, so a wrong value fails in the REPL with the CLI's message.

`movies.record()` starts `tools recorder start` in its own process and waits up to 120 s for it to record. The two
race for one start gate (`src/utils/process/start-gate.ts`, on `claimPidFile`): the recorder passes it right before
it records, after ax-tool is built, and the wait closes it when it gives up. A recorder that comes after the close
records nothing and exits 1 ("not recording: the caller … gave up"); one that passed first gets 30 s more to record,
and is stopped by its pid when it does not. The flag is `--start-gate <path>` (hidden; only `movies.record` passes
it). There is nothing to clean up after a give-up.

`transcript()` runs `tools transcribe` once and caches the result beside the movie (`refresh: true` transcribes
again); the first run may ask for the AI vault key in GenesisTools.app. A movie recorded without sound is refused.

## Troubleshooting

- **The first `start` in a checkout waits silently for a minute.** It builds ax-tool once; `--json` prints a
  `preparing` event, the text mode a line on stderr.
- **"GenesisTools.app has no recorder part yet: building it".** The installed app lacks the recorder part, and the
  CLI builds it (about a minute). From the REPL, run `tools macos permissions build --add-part recorder` in a shell
  first.
- **A start fails with a permission error.** Grant Screen Recording (and Microphone or Camera when you record them)
  in System Settings. `tools macos permissions` exits 1 while a grant is missing.
- **`--camera` is refused.** The menu bar recorder must run, because only it writes `camera.mov`. Start it with
  `tools recorder library --no-focus`, then start again.
- **The editor draws no pointer.** In Cursor and Clicks, turn on Show cursor. A hidden cursor still keeps clicks for
  click rings, annotations and auto zoom. Older recordings without a cursor track cannot recover their clicks.
- **An export says the file exists.** Exports never overwrite. Pass another `--out`, or `--overwrite`.
- **An export above 2560×1600 came out smaller.** H.264 fits the size to keep 60 fps. Export HEVC for the full size.
- **`undo` is refused.** The editor window changed the edit since; undo that with ⌘Z there. `redo` works only while
  the edit has not changed since the undo.
- **`subtitles`, `finish`, `words`, `cut-words`, `cut-fillers` or `replace-words` says there is no transcript.** None of them
  makes it. Run `tools recorder transcribe <recording>`, `movie.transcript()` or the Captions tab's Transcribe. An
  uncached transcription is a paid cloud call.
- **An effect lands up to 2 s off.** It was placed from ffmpeg frame numbers, which drift on a variable-frame-rate
  screen recording. Survey with `sheet`, `still`, `events` and `find-text`: they read frames on the editor's time base.
- **`window close` answers 1021.** The window has a drag not saved yet or an export running. Wait and try again.
- **`trash` asks for approval.** An agent's call, or a recording the removal policy does not allow, waits for
  `tools rm approve <id>`. A meeting's screen recording stays; remove it with `tools meetings`.

## Related

- [node-repl](../node-repl/README.md): the `movies` toolset, scripts and presets.
- [meetings](../meetings/README.md): meeting recordings, which `proxy`, `find-screen` and the transcript commands
  take by meeting id.
- [control](../control/README.md): ax-tool, the native recorder, and the `tools control` steps a demo script runs.
- [transcribe](../transcribe/README.md): the transcript behind captions, subtitles, `cut-words` and `cut-fillers`.
- [say](../say/README.md): the voice behind `movie.say()`.
- [rm](../rm/README.md): the removal policy `trash` goes through.
- [macos](../macos/README.md): GenesisTools.app, its parts and the privacy grants.
