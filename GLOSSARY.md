# Glossary

Domain terms that name modules and seams in GenesisTools. One meaning per word; the code, the plans and the reviews use
these names.

## Recorder and editor

- **Recording**: one capture in the recordings library (`<genesis-tools root>/recordings/library/<id>/`), or a meeting's
  frames folder. It holds the movie or frames, `recording.json` and, once edited, `edit.json`.
- **Edit project**: the JSON document in `edit.json` that says how a recording plays: clips, zooms, texts, shapes, hidden
  parts, effect lanes, audio, camera, export settings. Its schema is `editProjectSchema` in
  `src/utils/recording-editor/project.ts`.
- **Edit op**: one typed change to an edit project (`split`, `zoom`, `range`, ...), the `EditOp` union in the same file,
  applied by `applyOp`.
- **Edit session**: the one owner of an edit project while the recorder service runs. It applies ops in memory, checks
  the revision on disk before it writes, saves after a short delay, keeps the undo stack and runs gestures.
- **Gesture**: a continuous change (a drag) made of `begin`, any number of `preview`s that change only a draft, and
  `commit` (one undo step) or `cancel`.
- **Recorder service**: the one resident TypeScript process (`tools recorder serve`) that every recorder client talks to
  over one JSON-RPC 2.0 Unix socket, in both directions.
- **Recorder host**: the side that can draw: the Swift app's recorder part. It connects to the recorder service and
  answers window, render and camera requests. In TypeScript, `RecorderHost` is the seam, with the connected app and the
  headless app face as its two adapters.
- **Live recording**: a recording while its capture runs. Its own process owns the capture and serves a per-recording
  control socket (`RecorderControl`).
- **Recorder face**: the recorder part of GenesisTools.app, started with `--recorder`: the menu bar item, the editor and
  library windows, and the headless render modes.
