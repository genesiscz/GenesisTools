# Editing playbook: from a raw recording to a finished cut

Written 2026-11-07 from Martin's review of an agent-made demo edit (a scrolling iOS simulator movie), and updated
from what three editors hit in editing loops rounds 1 to 4. Every rule here fixes a mistake an edit made. Read it
before you edit any recording that you did not just record with demo mode.

## 0. How to run an edit

- Put the edit in a script file and run it in one process with a long budget, always with `--timeout`
  (milliseconds): `tools node-repl run --toolset movies --timeout 600000 --file edit.js` gives 10 minutes,
  `--timeout 1800000` gives 30. Without it the run gets the REPL's short default and is killed in the middle of the
  edit. For many small steps, use the MCP server (`tools node-repl mcp --toolset movies`), which keeps bindings.
- 🛑 Never pipe a run into `head` or `tail`: `tail` waits for the end and `head` can stop the run early. Write it to
  a file and read the file:
  `tools node-repl run --toolset movies --timeout 600000 --file edit.js > edit.log 2>&1`, or start it as a background
  task of your harness (Claude Code: Bash `run_in_background`) and read `edit.log`. A trailing `&` in a shell call is
  no background task: the run dies with that shell.
- A background run of your harness has its own time limit, and the run has another: give both. A Bash
  `run_in_background` call needs `timeout` above the run's `--timeout` (an edit with `hideText` and `verifyHidden` on
  a long movie takes 30 to 60 minutes), or the harness stops it half way. For a session of many long calls, use the
  MCP server (`tools node-repl mcp --toolset movies`), where each call has its own budget and the bindings stay.
- 🛑 Never `pkill` or `killall` a shared process to stop your run: `bun`, `ffmpeg`, `node-repl` and the recorder
  service (`tools recorder serve`) also run other editors' edits and the user's own work. Stop your own run by the
  task id your harness gave it, or by the one pid you started.
- Every slow read of a movie (its screen text, the dense reads around a moving text, the motion, the change steps, the
  scene times) is kept once per movie CONTENT in `~/.genesis-tools/recorder/analysis/`, so a copy made with
  `duplicate()` or `cp -c` reads nothing again, and a second editor that asks for the same read while the first one
  reads waits for it and takes its answer. Two editors of one demo therefore cost one OCR, not two.
- `help("movies")` lists every method in one line each. `describe("movies.Movie.<name>")` prints one in full: its
  types, its whole doc, its parameters. Read the describe of a method before you use it the first time.
- `describe()`, `help()` and `search()` RETURN their text. A bare call on its own line prints it (and so does the last
  line of a script); inside an expression, print it yourself: `console.log(describe("movies.Movie.sheet"))`.
- `console.log` lines of `tools node-repl run` and the script's result are its output. Do not count on seeing a line
  the moment the script writes it: log a line before each slow call (`hideText`, `verifyHidden`, `export`), so the
  output shows which call a run that stopped was in.
- Every edit call answers `summary` (the edit AFTER this call) and `changed` (what THIS call did, "0 texts → 16
  texts"). A script that starts with `reset()` and adds texts later shows no texts in the summary of its first
  `apply()`: that is the state at that point, not a lag.

## 1. Two clocks, one time base

- SOURCE seconds: the recording as recorded. Every op takes them (`cut`, `zoom`, `text`, `redact`, `hideText`,
  `voiceover`, `marker`), and a cut never moves them.
- OUTPUT seconds: the edited movie, what plays after cuts and speed changes. `still()`, `sheet()`, `itemsAt()`,
  `range()` and `export({ from, to })` take them.
- The exported file plays the intro card first. `info().exportTime` gives `introSeconds`, `endSeconds` and
  `exportSeconds`; a voiceover's `exportPlays`, and a sheet cell's `export`, are times in the exported file.
- 🛑 Survey only with `sheet()`, `still()`, `events()` and `findText()`. They read frames with the editor's own
  decoder (or sample on its time base), so a time you read there is the time to put in an op. Never place an effect
  from ffmpeg frame numbers: the fps filter takes the NEAREST frame (up to half a step later), and the frame numbers
  of a variable-frame-rate screen recording drift by seconds. Editors who surveyed with ffmpeg placed boxes up to 2 s
  wrong.

## 2. Available now: the calls of an edit

Every call below exists in the `movies` toolset today (`m = await movies.open(id)`). One example each.

| Call | What it does | Example |
|---|---|---|
| `m.duplicate({ title })` | A copy of the recording and its edit (APFS clones) IN THE RECORDING LIBRARY. Removing it later asks the user (`tools rm` does not delete a library folder by itself), so duplicate only a copy you keep; for a throwaway try, `undo()` or `reset()` the edit instead | `const copy = await movies.open((await m.duplicate({ title: "cut-r2" })).folder)` |
| `movies.import(path, { title, markers })` | A movie file that exists already (a render, an export; .mp4, .m4v or .mov) as a new recording IN THE RECORDING LIBRARY: an APFS clone, the file untouched, the markers (`{ at, label }`, at in source seconds) in its marker list, its sound kept. It returns the Movie, as `open()` does. Use it instead of writing a library folder by hand; `tools recorder trash <id>` removes it | `const m = await movies.import("/path/render.mp4", { title: "Tour", markers: [{ at: 0, label: "Intro" }] })` |
| `m.info()` | The edit now, with `exportTime` and each voiceover's `plays` and `exportPlays` | `(await m.info()).outputSeconds` |
| `m.sheet({ source, every, from, to, columns })` | Up to 48 frames on one grid; `cells` give each time on every clock | `await m.sheet({ source: true, from: 40, to: 52, every: 0.5 })` |
| `m.sheet({ source: true, effects: true, ... })` | Source seconds drawn THROUGH the edit (blurs, zooms, texts, frame); a cell whose time is cut gets a red border and "cut" (`cells[i].cut`). The tool for boundary checks (section 9) | `await m.sheet({ source: true, effects: true, at: [41.9, 42, 43.5, 43.6] })` |
| `m.still({ at, source, full })` | One frame; `full: true` is the export's size, for small text | `await m.still({ at: 49.2, source: true, full: true })` |
| `m.itemsAt(t)` | What plays at an OUTPUT second, in words | `await m.itemsAt(12.5)` |
| `m.events({ kinds, taps })` | Scene changes, scrolls, still stretches, clicks, at source seconds. A scene is where the picture changes, at its first frame (also on a simulator recording with uneven frame times): a tap whose screen loads for 2 s has its scene 2 s after the tap. A simulator movie has no cursor track, so pass the taps you know (`taps: [{ at }]`) to place an effect on the tap itself | `await m.events({ kinds: ["scene", "scroll"] })` |
| `m.snap({ event, index, lead })` | One event's source time, to place an effect on | `(await m.snap({ event: "scene", index: 3, lead: -0.3 })).at` |
| `m.findText({ text \| pattern \| texts \| patterns, unit, from, to })` | Where texts show, tracked through scrolls; several texts and patterns in ONE scan (each scan costs 10 to 60 s, so pass them together); `from`/`to` (source seconds) limit the scan as in `hideText`. A pattern matches each OCR line on its own, case-insensitive; `^` and `$` anchor to that line. Patterns know every script (the `u` flag): `\w` and `\b` take Czech and other letters, `\p{L}` is any letter, `\p{Lu}` a capital. The answer is the array of hits; a text or pattern that matched no screen text is named in its `warnings` (`found.warnings`, absent when every one matched), and `hideText()` and `hidePrivate()` (its names) put the same in their own `warnings`: read them, a missed text hides nothing | `await m.findText({ texts: ["Alice Example"], patterns: ["\\d{4} \\d{4}"] })` |
| `m.privateData()` | Emails, tokens, phone numbers, IBANs, card numbers on screen | `await m.privateData({ names: ["Alice Example"] })` |
| `m.hideText({ text \| pattern \| texts \| patterns, unit, style, exclude, excludeFixed })` | Hides each place a text shows, following it frame by frame through scrolls and slide-ins by the measured motion. `unit: "line"` hides the whole OCR line (the number beside a hidden name too). Read `hiding.uncertain` in the answer: stretches where the text could not be followed, covered by the band it may cross. A sliding or scrolling text is read 10 times a second, and its part keeps the read line's whole width with half a line of margin. `excludeFixed` leaves the fixed areas visible: never use it when a fixed area holds private text (section 5) | `await m.hideText({ texts: ["Alice Example", "Main Street 1"], unit: "line" })` |
| `m.unhide({ text \| pattern \| ids \| all })` | Takes back what `hideText`/`hidePrivate` hid, and forgets it, so the same hide can run again; hand-drawn boxes and spotlights stay. `all: true` with nothing hidden changes nothing and says "nothing hidden". `info().redactions[i].kind` is `hidden` or `spotlight`, `hide.request` names the hide that made a part | `await m.unhide({ text: "Alice Example" })` |
| `m.hidePrivate({ kinds, ids })` | Hides what `privateData()` lists | `await m.hidePrivate({ kinds: ["email", "phone"] })` |
| `m.verifyHidden({ text \| pattern \| texts \| patterns \| private, movie, everySeconds, aroundSeconds })` | Exports, reads the OUTPUT and lists every leak; all texts in one call. Besides the even samples it reads EVERY frame within `aroundSeconds` (0.2) of each cut, transition, zoom and hidden-part edge and scene change, where leaks hide. A head or tail of a value at a screen edge counts ("part at an edge"), and so does a piece of a hidden value anywhere in a line: 4 or more of its digits in a row, or a word of 4 or more of its letters that starts or ends it ("part of a hidden value"), as a box over only the left part of a line leaves. Each leak has `source`/`output` seconds, `box` (export frame fractions) and `sourceBox` (source fractions, the space `redact` takes); `fixOps` are ready `redact` ops for each leak it could place in the source. Not every leak gets one: a leak in a card (`source: null`) needs the card's text changed, and a leak with no place in the source picture needs a box by hand; each of them has a line in `notes`. After `apply(fixOps)`, handle each line of `notes`, then export and verify again. `movie` checks an export you made instead of a fresh default one | `const v = await m.verifyHidden({ private: true, texts: ["Alice Example"], movie: out }); if (!v.ok) { v.notes?.forEach((note) => console.log(note)); if (v.fixOps.length > 0) await m.apply(v.fixOps) }` |
| `m.waits()` / `m.speedUpWaits({ ids })` | Typing and waiting stretches, sped up 4x to 8x with a badge | `await m.speedUpWaits({})` |
| `m.cut(from, to)` / `m.speed(from, to, x)` | Cut or speed a source range; a factor from 0.25 to 16, below 1 is slow motion | `await m.cut(5.6, 9.8)`; `await m.speed(61, 62.5, 0.5)` |
| `m.zoom({ from, to, scale, focus })` | Zoom inside the picture. A zoom crops the picture's edges: 1.2x on a phone already cuts the side labels. `check()` names a zoom whose view cuts screen text (a `zoom-cuts-text` issue with a setZoom that fits, once `findText` or `hideText` has read the screen) | `await m.zoom({ from: 49, to: 54, scale: 1.4, focus: { x: 0.5, y: 0.3 } })` |
| `m.spotlight({ from, to, rect, dim, dimAround })` / `m.lens(...)` | Point at a part; a lens keeps the context. The rest dims by `dim` (0.5 by default, so it stays readable; 0.7 is strong). `dimAround` (0 to 0.5 of the picture's short side) lets the dim rise softly from the lit shape, so the frame around it stays readable: 0.1 is a good start | `await m.spotlight({ from: 61, to: 64, rect, dimAround: 0.1 })`; `await m.lens({ from: 61, to: 64, at: { x: 0.3, y: 0.9 } })` |
| `m.text({ from, to, text, x, y, animate })` | A title or a callout on the canvas | `await m.text({ from: 10, to: 16, text: "1. Sign in", x: 0.17, y: 0.12 })` |
| `m.frame({ aspect, background, padding })` | The canvas around the movie | `await m.frame({ aspect: "9:16", padding: 0.04 })` |
| `m.transition({ kind, ms })` | Crossfade, zoom or blur at the cuts | `await m.transition({ kind: "crossfade", ms: 300 })` |
| `m.marker(at, label)` / `m.progress({ chapterPlace })` | Chapters and the progress bar; each chapter's name shows in the frame's free area by default (`chapterPlace: "auto"`), never over the movie; `"topLeft"` and the other corners pin it | `await m.marker(40.4, "Dashboard")`; `await m.progress({ chapterPlace: "auto" })` |
| `m.introCard(...)` / `m.endCard(...)` | Cards the export plays before and after | `await m.introCard({ title: "Customer app", seconds: 3 })` |
| `m.say({ at, text })` / `m.voiceover({ at, file })` | A voice line placed at a source second | `await m.say({ at: 10.2, text: "Sign in takes one tap." })` |
| `m.music({ file, volume, duck })` / `m.ducking({ db })` | Music, quieter under speech. Two different scales: `music({ duck })` is a share 0 to 1 (0.6 drops it TO 40 %), `ducking({ db })` is decibels quieter (12). `ducking()` replaces `duck` once set | `await m.music({ file, volume: 0.25 })`; `await m.ducking({ db: 14 })` |
| `m.check()` / `m.fix()` | What to look at before export, and its fixes. Read `summary` first: one line per kind with its count ("check ×12 hiding-starts-after-cut: …"); `groups` has the items and times, `issues` every one. Severity `fix` breaks the export, `check` needs a look, `note` is a hole the export closes by itself | `(await m.check()).summary` |
| `m.export({ out })` | Renders the movie | `await m.export({ out: "/tmp/cc/<project>/<session>/cut.mp4" })` |
| `m.undo()` / `m.reset()` | Takes back the last change; starts over (music, voiceovers and cards go too) | `await m.undo()` |

| `m.frame({ preset })` | A phone layout: `phone-left` / `phone-right` (16:9, the phone takes about the left or right quarter; the rest, x 0.27 to 1 or 0 to 0.73, is free for text), `phone-portrait` (9:16, the phone from the top; the bottom 0.135 of the height, y 0.865 to 1, is free for captions and chapter names); `layout: { align, scale, focus }` for your own. A whole phone is at most about 0.27 of a 16:9 width; `layout.scale` above 1 grows it inside the padding and crops its height, and `layout.focus` (0..1 of the phone from its top left) keeps that part in view | `await m.frame({ preset: "phone-left", layout: { scale: 1.5, focus: { x: 0.5, y: 1 } } })` (0.36 wide, the tab bar in view, the top third out) |
| `m.zoom({ ..., target: "canvas" })` | Zooms the whole framed picture, not only inside the phone | `await m.zoom({ from: 52, to: 58, scale: 1.4, target: "canvas" })` |
| `m.redact({ ..., cell })` / `m.redactionJoins({ snapMs })` | Pixelate block size in source pixels; boxes up to 250 ms apart (or from a cut) meet, so no frame shows between them | `await m.redact({ from, to, rect, style: "pixelate", cell: 24 })` |
| `m.text({ text: "a\nb", block })` | Several lines (up to 500 characters), wrapped in a block of `width` centred on `x`; `align` "left" or "right" puts the plate against that block's edge, so texts with one `x` and block line up | `await m.text({ from, to, text: "Step 1\nOpen the inbox", x: 0.72, block: { width: 0.4, align: "left" } })` |
| `m.export({ out, overwrite, size })` | Replaces an older export in one step; an explicit size (`{ height: 1080 }`) | `await m.export({ out, overwrite: true, size: { height: 1080 } })` |

## 3. Recipe: a privacy-safe cut of a phone recording

1. Copy: `const copy = await (await movies.open(id)).duplicate({ title: "demo-cut-r2" })`, then
   `const m = await movies.open(copy.id ?? copy.folder)`. Never edit the
   only edit of a recording.
2. Survey on the source clock: `info()`, then `events()`, then `sheet({ source: true, count: 24 })` over the whole
   movie and `sheet({ source: true, from, to, every: 0.5 })` over each busy stretch. Write a table of source seconds
   with what happens ("49.2 s: the detail screen opens").
3. Cut the loading screens and the waiting: a splash or a spinner says nothing. `cut()` what shows nothing new,
   `speedUpWaits()` what must stay but is slow. Read `changed` and `warnings` after each call: a time past the end is
   clamped, and `check()` keeps naming it.
4. Hide the private data by its text, never by a box of the screen: `privateData()` and one `findText({ texts,
   patterns })` list it, `hidePrivate()` and one `hideText({ texts, patterns, unit: "line" })`
   hide it and follow it through every scroll and slide-in. Keep the scrolls: they show the app, and the hiding
   follows them. Read `hiding.uncertain`; each stretch there is covered by a wider band, so look at it on an effects
   sheet. Use a fixed `redact()` box only for a still stretch, measured on a `still({ source: true, full: true })`
   (section 5 says how).
5. Frame it: a phone (9:16) uses `frame({ aspect: "9:16" })` or "4:5" with padding, and titles go in the padding,
   never over the app's text or the status bar (section 6).
6. Place every effect on an event from step 2 (section 4) and add the story: an intro card, markers, short callouts.
7. Sound: voice lines with `say()` at source seconds, music with `ducking()` (section 8).
8. `check()`, then `fix()` what it offers, then check every boundary (section 9).
9. Export, then one `verifyHidden({ private: true, texts: [...every text you hid], patterns: [...every pattern you
   hid], movie: <the exported file> })`. Pass every text and pattern of step 4, not only the names: it checks only
   what it is given and the built-in private data, so an address or an id you hid by a pattern goes unchecked
   otherwise. Pass the file you deliver as `movie`: without it, it renders a separate default export of its own
   (removed after the check), which can differ from yours in size or format. `ok: false` is a failed edit: apply its
   `fixOps` (or place your own boxes from each leak's `sourceBox`, never from `box`), handle each line of its `notes`
   (a leak no op covers: a card's text, a box by hand), export again and verify that new file again. It reads every
   frame around cuts, transitions and scene changes, so it takes minutes: log before it.
10. Score it (section 10).

## 4. Place every effect on an event, never on a guess

- `events()` names each scene change at the frame it starts on, a tab tap that swaps the content above a fixed tab bar
  included, and a slide that spreads over half a second is one scene at its start. Take scene times from it, with
  `snap({ event: "scene", index, lead: -0.3 })`. Look at a dense source sheet
  (`sheet({ source: true, effects: true, from, to, every: 0.2 })`) when a change is small (a toggle, one row) or
  when you place an effect's END on a moment events() does not name.
- A zoom, spotlight or callout starts 0.2 to 0.4 s BEFORE the moment it explains (the tap, the screen change) and ends
  after the viewer had time to read it. `snap({ event, index, lead: -0.3 })` gives that second.
- The zoom's focus is the thing you talk about, measured from a still at that time (the rect of the element), not the
  centre of the screen. Check the zoomed still: the thing must be inside the view with margin, and no text may be cut
  at the view's edge (a half label reads as a mistake). Lower the scale or move the focus until the lines are whole;
  `check()` lists the zooms that cut text it has read.
- Prefer a lens or a spotlight to a zoom when the context around the thing matters.

## 5. Privacy: hide the text, not a box of the screen

- Content that moves (scrolls, screen changes) cannot be hidden with a fixed box for a fixed time. `hideText()` and
  `hidePrivate()` follow the text frame by frame by the measured motion of the content (also through blurred frames
  the OCR cannot read), never join two different texts, and start and end with the text. Where they cannot follow,
  they hide the band the text may cross and name that stretch in `hiding.uncertain` and in `check()`.
- `unit: "line"` hides a whole line: use it for a name with a contract number or an address beside it.
- Leave out what does not move with the content and holds nothing private (a toast, a tab bar, the status bar) with
  `exclude` or `excludeFixed: true`.
- 🛑 A fixed header that holds private text (the user's name, a device or contract number) is NOT such an area: do not
  use `excludeFixed` there, and never `exclude` it. An excluded area shows the picture through the part that excludes
  it; only another hidden part that covers it without excluding it keeps it hidden. When in doubt, leave
  `excludeFixed` off: a blurred tab bar costs less than a leaked name.
- A hand box for a still stretch: take `still({ at, source: true, full: true })`, measure the text's rectangle in its
  pixels, and divide by the still's width and height: that is the source fraction `redact({ rect })` takes. Never
  measure on a `sheet()` cell: a cell is a scaled picture inside a grid with labels, and its pixels are not the source
  frame's. Pad the box by half a line height on each side.
- Hidden parts may overlap: overlapping blurs stay blurred, and an area one part excludes stays hidden where another
  part covers it. You do not need to merge boxes by hand.
- A box must never stay on after its text left: it then blurs the next screen's harmless content.
- Verify the OUTPUT with `verifyHidden({ movie })` after the export, on the file you deliver, with every text and
  pattern you hid. A leak found after delivery is a failed edit.
- When `verifyHidden()` still names leaks in a scroll or a slide-in, do not cut the scroll and do not pixelate the
  whole screen for seconds. Apply its `fixOps` first: each covers one leak in source time and space. Otherwise look at
  the leak times on a
  `sheet({ source: true, effects: true, from, to, every: 0.2 })`, then cover only that stretch: a `redact()` box over
  the band the text moves through, from the frame before the leak to the frame after it, joined to the tracked parts
  (`redactionJoins` closes holes up to 250 ms). Export and verify again.

## 6. Layout of portrait footage

- A phone (9:16) in a 16:9 frame leaves most of the picture empty. Choose the frame aspect from the source (9:16 or 4:5
  for a phone), or use the empty side for titles and callouts on purpose.
- Titles and callouts never cover the app's own text or the status bar. Place them in the frame's padding or beside the
  phone. `text()` takes x and y on the CANVAS, so a title in the padding stays there through a zoom.
- The free bands of the presets: `phone-portrait` leaves y 0.865 to 1 (the bottom 0.135); put captions and one-line
  callouts there (y about 0.93). `phone-left` leaves x 0.27 to 1 (texts at x 0.62, `block: { width: 0.6 }`),
  `phone-right` x 0 to 0.73 (texts at x 0.38). A bigger phone: `layout: { scale: 1.5 }` makes it about 0.36 wide and
  leaves x 0.38 to 1 free (a 0.4 wide block at x 0.7 fits); it crops a third of the phone's height, so set
  `layout.focus` to keep what the cut is about (y 1 keeps the tab bar, y 0 the header). The progress bar's chapter names go into the same free area by
  themselves; two texts at the same time must not overlap there (`check()` compares their drawn plates).

## 7. Do not point at failures

Test environments show error toasts and empty values. Close developer toasts before you record. In the edit, do not
spotlight, zoom or box an error state unless the video is about that error; cut or hide those moments instead.

## 8. Sound

- Voiceover lines are clips placed at source times (`voiceover`, `say`), so they move with cuts and speed changes.
  Never premix voice and music outside the editor when clips exist.
- Music under speech ducks (`ducking({ db: 12 })`, in decibels; the older `music({ duck })` is a share 0 to 1, so
  `duck: 12` is refused and `db: 0.6` barely ducks). Generate or pick music the user may use; never a commercial song.
- Write each line for the moment it plays: one idea, at most about 2.5 words per second of the stretch it covers.

## 9. Check every boundary before you export

For each effect: a frame 0.1 s before its start, at its start, in its middle, at its end and 0.1 s after, on one sheet.
Use source seconds drawn through the edit, `sheet({ source: true, effects: true, at: [...] })`: the times are the ones
in your ops, and a time the edit cuts is marked "cut", so you see at once that a boundary falls in a cut. Typical misses: a blur on before its text appears, a zoom late or off target, a title over
the status bar, an effect left on into the next screen.

## 10. Score your own cut before you hand it over

Score 0 to 10 against this list: timing on events (2), privacy with no leak and no over-blur (2), framing and layout
(2), story (title, chapters, callouts that explain) (2), sound (voice clear, music ducked, no clipping) (2). Name what
cost each lost point. Fix what you can and score again. Hand over the score with the cut.
