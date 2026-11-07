# Editing playbook: from a raw recording to a finished cut

Written 2026-11-07 from Martin's review of an agent-made demo edit (a scrolling iOS simulator movie), and updated the
same day from what three editors hit in editing loops round 1 and round 2. Every rule here fixes a mistake an edit made. Read it
before you edit any recording that you did not just record with demo mode.

## 0. How to run an edit

- Put the edit in a script file and run it in one process with a long budget:
  `tools node-repl run --toolset movies --file edit.js` (a run with `movies` gets 10 minutes; `--timeout 1800000`
  gives 30). For many small steps, use the MCP server (`tools node-repl mcp --toolset movies`), which keeps bindings.
- `help("movies")` lists every method in one line each. `describe("movies.Movie.<name>")` prints one in full: its
  types, its whole doc, its parameters. Read the describe of a method before you use it the first time.
- `describe()`, `help()` and `search()` RETURN their text. A bare call on its own line prints it (and so does the last
  line of a script); inside an expression, print it yourself: `console.log(describe("movies.Movie.sheet"))`.
- `console.log` lines of `tools node-repl run` print as the script writes them, so a long edit shows its progress; the
  script's result prints when it ends. Log a line before each slow call (`hideText`, `verifyHidden`, `export`).
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
| `m.duplicate({ title })` | A copy of the recording and its edit (APFS clones) | `const copy = await movies.open((await m.duplicate({ title: "cut-r2" })).folder)` |
| `m.info()` | The edit now, with `exportTime` and each voiceover's `plays` and `exportPlays` | `(await m.info()).outputSeconds` |
| `m.sheet({ source, every, from, to, columns })` | Up to 48 frames on one grid; `cells` give each time on every clock | `await m.sheet({ source: true, from: 40, to: 52, every: 0.5 })` |
| `m.sheet({ source: true, effects: true, ... })` | Source seconds drawn THROUGH the edit (blurs, zooms, texts, frame); a cell whose time is cut gets a red border and "cut" (`cells[i].cut`). The tool for boundary checks (section 9) | `await m.sheet({ source: true, effects: true, at: [41.9, 42, 43.5, 43.6] })` |
| `m.still({ at, source, full })` | One frame; `full: true` is the export's size, for small text | `await m.still({ at: 49.2, source: true, full: true })` |
| `m.itemsAt(t)` | What plays at an OUTPUT second, in words | `await m.itemsAt(12.5)` |
| `m.events({ kinds, taps })` | Scene changes, scrolls, still stretches, clicks, at source seconds | `await m.events({ kinds: ["scene", "scroll"] })` |
| `m.snap({ event, index, lead })` | One event's source time, to place an effect on | `(await m.snap({ event: "scene", index: 3, lead: -0.3 })).at` |
| `m.findText({ text \| pattern })` | Where a text shows, tracked through scrolls | `await m.findText({ pattern: "\\d{4} \\d{4}" })` |
| `m.privateData()` | Emails, tokens, phone numbers, IBANs, card numbers on screen | `await m.privateData({ names: ["Alice Example"] })` |
| `m.hideText({ text \| pattern, style, exclude, excludeFixed })` | Hides each place a text shows, following it | `await m.hideText({ text: "alice@example.com", style: "blur", excludeFixed: true })` |
| `m.hidePrivate({ kinds, ids })` | Hides what `privateData()` lists | `await m.hidePrivate({ kinds: ["email", "phone"] })` |
| `m.verifyHidden({ text \| pattern \| private })` | Exports, reads the OUTPUT and lists every leak | `(await m.verifyHidden({ private: true })).ok` |
| `m.waits()` / `m.speedUpWaits({ ids })` | Typing and waiting stretches, sped up 4x to 8x with a badge | `await m.speedUpWaits({})` |
| `m.cut(from, to)` / `m.speed(from, to, x)` | Cut or speed a source range; a factor from 0.25 to 16, below 1 is slow motion | `await m.cut(5.6, 9.8)`; `await m.speed(61, 62.5, 0.5)` |
| `m.zoom({ from, to, scale, focus })` | Zoom inside the picture | `await m.zoom({ from: 49, to: 54, scale: 1.4, focus: { x: 0.5, y: 0.3 } })` |
| `m.spotlight({ from, to, rect })` / `m.lens(...)` | Point at a part; a lens keeps the context | `await m.lens({ from: 61, to: 64, at: { x: 0.3, y: 0.9 } })` |
| `m.text({ from, to, text, x, y, animate })` | A title or a callout on the canvas | `await m.text({ from: 10, to: 16, text: "1. Sign in", x: 0.17, y: 0.12 })` |
| `m.frame({ aspect, background, padding })` | The canvas around the movie | `await m.frame({ aspect: "9:16", padding: 0.04 })` |
| `m.transition({ kind, ms })` | Crossfade, zoom or blur at the cuts | `await m.transition({ kind: "crossfade", ms: 300 })` |
| `m.marker(at, label)` / `m.progress({ chapterPlace })` | Chapters and the progress bar; each chapter's name shows in the frame's free area by default (`chapterPlace: "auto"`), never over the movie; `"topLeft"` and the other corners pin it | `await m.marker(40.4, "Dashboard")`; `await m.progress({ chapterPlace: "auto" })` |
| `m.introCard(...)` / `m.endCard(...)` | Cards the export plays before and after | `await m.introCard({ title: "Customer app", seconds: 3 })` |
| `m.say({ at, text })` / `m.voiceover({ at, file })` | A voice line placed at a source second | `await m.say({ at: 10.2, text: "Sign in takes one tap." })` |
| `m.music({ file })` / `m.ducking({ db })` | Music, quieter under speech | `await m.ducking({ db: 14 })` |
| `m.check()` / `m.fix()` | What to look at before export, and its fixes. Read `summary` first: one line per kind with its count ("check ×12 hiding-starts-after-cut: …"); `groups` has the items and times, `issues` every one. Severity `fix` breaks the export, `check` needs a look, `note` is a hole the export closes by itself | `(await m.check()).summary` |
| `m.export({ out })` | Renders the movie | `await m.export({ out: "/tmp/cc/<project>/<session>/cut.mp4" })` |
| `m.undo()` / `m.reset()` | Takes back the last change; starts over (music, voiceovers and cards go too) | `await m.undo()` |

| `m.frame({ preset })` | A phone layout: `phone-left` / `phone-right` (16:9, the phone takes about the left or right quarter; the rest, x 0.27 to 1 or 0 to 0.73, is free for text), `phone-portrait` (9:16, the phone from the top; the bottom 0.135 of the height, y 0.865 to 1, is free for captions and chapter names); `layout: { align, scale }` for your own | `await m.frame({ preset: "phone-left" })` |
| `m.zoom({ ..., target: "canvas" })` | Zooms the whole framed picture, not only inside the phone | `await m.zoom({ from: 52, to: 58, scale: 1.4, target: "canvas" })` |
| `m.redact({ ..., cell })` / `m.redactionJoins({ snapMs })` | Pixelate block size in source pixels; boxes up to 250 ms apart (or from a cut) meet, so no frame shows between them | `await m.redact({ from, to, rect, style: "pixelate", cell: 24 })` |
| `m.text({ text: "a\nb", block })` | Several lines (up to 500 characters), wrapped in a block of `width`, `align` | `await m.text({ from, to, text: "Step 1\nOpen the inbox", x: 0.72, block: { width: 0.4, align: "left" } })` |
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
4. Hide the private data by its text, never by a box of the screen: `privateData()` and `findText()` list it,
   `hidePrivate()` and `hideText({ excludeFixed: true })` hide it and follow it through every scroll. Use a fixed
   `redact()` box only for a still stretch, measured on a `still({ source: true, full: true })` of that stretch.
5. Frame it: a phone (9:16) uses `frame({ aspect: "9:16" })` or "4:5" with padding, and titles go in the padding,
   never over the app's text or the status bar (section 6).
6. Place every effect on an event from step 2 (section 4) and add the story: an intro card, markers, short callouts.
7. Sound: voice lines with `say()` at source seconds, music with `ducking()` (section 8).
8. `check()`, then `fix()` what it offers, then check every boundary (section 9).
9. Export, then `verifyHidden({ private: true })` and `verifyHidden({ text })` for each name you hid. `ok: false` is
   a failed edit: fix the leak and export again.
10. Score it (section 10).

## 4. Place every effect on an event, never on a guess

- `events()` finds scene changes when most of the picture changes. A tab tap that changes only part of the screen, or
  a quick screen change, can fall between its samples or below its threshold: find those on a dense source sheet
  (`sheet({ source: true, from, to, every: 0.2 })`) and read the exact second there.
- A zoom, spotlight or callout starts 0.2 to 0.4 s BEFORE the moment it explains (the tap, the screen change) and ends
  after the viewer had time to read it. `snap({ event, index, lead: -0.3 })` gives that second.
- The zoom's focus is the thing you talk about, measured from a still at that time (the rect of the element), not the
  centre of the screen. Check the zoomed still: the thing must be inside the view with margin.
- Prefer a lens or a spotlight to a zoom when the context around the thing matters.

## 5. Privacy: hide the text, not a box of the screen

- Content that moves (scrolls, screen changes) cannot be hidden with a fixed box for a fixed time. `hideText()` and
  `hidePrivate()` follow the text and start and end with it.
- Leave out what does not move with the content (a toast, a tab bar, the status bar) with `excludeFixed: true` or
  `exclude`.
- A box must never stay on after its text left: it then blurs the next screen's harmless content.
- Verify the OUTPUT with `verifyHidden()` after the export. A leak found after delivery is a failed edit.
- When `verifyHidden()` names leaks in a scroll or a slide-in (text the tracking could not follow), do not cut the
  scroll and do not pixelate the whole screen for seconds. Look at the leak times on a
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
  `phone-right` x 0 to 0.73 (texts at x 0.38). The progress bar's chapter names go into the same free area by
  themselves; two texts at the same time must not overlap there (`check()` compares their drawn plates).

## 7. Do not point at failures

Test environments show error toasts and empty values. Close developer toasts before you record. In the edit, do not
spotlight, zoom or box an error state unless the video is about that error; cut or hide those moments instead.

## 8. Sound

- Voiceover lines are clips placed at source times (`voiceover`, `say`), so they move with cuts and speed changes.
  Never premix voice and music outside the editor when clips exist.
- Music under speech ducks (`ducking({ db: 12 })`). Generate or pick music the user may use; never a commercial song.
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
