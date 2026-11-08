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
| A recording the person makes by hand | the capture picker: ⌘7 (or the menu bar item → Capture Picker…) |
| Edit an existing recording | `movies.open(id)` in the REPL, or `tools recorder apply <recording> '<ops>'` |

🛑 Before you edit a recording into a cut for someone (effects, privacy, voiceover, music), read
`references/editing-playbook.md` in full: work on a copy, survey first, place effects on screen events, hide text and
not boxes of the screen, check every effect boundary (on `sheet({ source: true, effects: true })`, which draws source
seconds through the edit and marks cut ones), read `check()`'s `summary` lines, and score the cut before you hand it
over. Run an edit script with `tools node-repl run --toolset movies --file edit.js`: its `console.log` lines print as
they happen. Write that output to a file (`> edit.log 2>&1`) or run it as a background task; never pipe it into
`head` or `tail`, which hold it until the end. Its section 2 is the
table of the calls that exist today, one example each; section 3 is the recipe for a privacy-safe cut.

## Editing at a glance

- Run an edit as a script: `tools node-repl run --toolset movies --file edit.js` (10 minutes by default with
  `movies`; `--timeout <ms>` for more). `help("movies")` lists the methods, `describe("movies.Movie.<name>")` prints
  one in full.
- One time base: ops take SOURCE seconds. Survey with `m.sheet({ source: true, every: 0.5, from, to })`,
  `m.still({ at, source: true, full: true })`, `m.events()` and `m.findText()`, never with ffmpeg frame numbers.
- Every edit call answers `summary` (the edit after it) and `changed` (what it did); `check()` before `export()`,
  `verifyHidden()` after it.

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

## Camera bubble

The picker's "Camera bubble" option records the camera beside the screen (`camera.mov`); the preview can be dragged
before and while recording and stays out of the movie. The edit's `camera` places it (corner or x/y, size, shape,
mirror); each part where it is hidden is a `cameraHide` item on the effect lanes. Change it with
`m.camera({ corner: "topLeft", size: 0.2 })`, `m.cameraHide(from, to)` or the ops `camera`, `cameraHide` (with
`lane`), `cameraShow`, `retime` and `moveToLane`. In the editor's Style tab the user drags the bubble on the preview
and sizes it by its grip; that writes the same `camera` op, so an agent reads the result with `m.info()` as usual. From a script, `record: { camera: true }` asks for the camera without a
preview on screen.

## Rules

- A recording is the person's screen: record only what the task needs, and say where the movie is.
- `movies.record()` waits up to 120 s for the first segment (a fresh checkout compiles ax-tool first). When it gives
  up, the start is cancelled: a recorder that comes later records nothing, and one that had begun its start gets 30 s
  more, then is stopped. Its error says which; there is nothing to clean up.
- Times in ops are SOURCE seconds; a cut never moves later items.
