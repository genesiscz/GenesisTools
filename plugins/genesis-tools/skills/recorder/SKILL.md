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
mirror, hidden ranges); change it with `m.camera({ corner: "topLeft", size: 0.2 })`, `m.cameraHide(from, to)` or the
ops `camera`, `cameraHide`, `cameraShow`. From a script, `record: { camera: true }` asks for the camera without a
preview on screen.

## Rules

- A recording is the person's screen: record only what the task needs, and say where the movie is.
- `movies.record()` waits up to 120 s for the first segment (a fresh checkout compiles ax-tool first). If it still
  gives up, end a late start with `tools recorder stop`.
- Times in ops are SOURCE seconds; a cut never moves later items.
