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
- **Edit session**: the one owner of an edit project, and the one place of its undo rules. The recorder service keeps a
  resident one while a client (a window) holds the edit open; every other undo, redo or collapse opens a short-lived one
  (`withEditSession`) that loads the file, saves and closes. It applies ops in memory, checks the revision on disk
  before it writes, saves after a short delay, keeps the undo stack and runs gestures.
- **Gesture**: a continuous change (a drag) made of `begin`, any number of `preview`s that change only a draft, and
  `commit` (one undo step) or `cancel`.
- **Recorder service**: the one resident TypeScript process (`tools recorder serve`) that every recorder client talks to
  over one JSON-RPC 2.0 Unix socket, in both directions.
- **Recorder host**: the side that can draw: the Swift app's recorder part. It connects to the recorder service and
  answers window, render and camera requests. In TypeScript, `RecorderHost` is the seam, with the connected app and the
  headless app face as its two adapters.
- **Live recording**: a recording while its capture runs. Its own process owns the capture and serves a per-recording
  control socket (`RecorderControl`). While a recorder service runs, the process also joins it as a `recording`
  connection, so clients reach it through the service (`recordings.live`, `recording.call`); it rejoins a service that
  restarts and keeps its own socket the whole time.
- **Recorder face**: the recorder part of GenesisTools.app, started with `--recorder`: the menu bar item, the editor and
  library windows, and the headless render modes.

## Meetings

- **Moment**: a bounded span of a meeting's audio, with its asked spot, the pad around it and the tone just before the
  spot. Any target has one: an item or a question, a time, a range, words picked in the transcript, one speaker's
  turn. The Moment engine (`src/meetings/lib/moment.ts`) computes it and cuts it to a WAV; it never plays sound. The
  terminal `listen`, `listen --clip-out`, `tools meetings play` and the Meetings window all ask it, so the span, pad,
  spot and tone policy lives in one place. A Moment also names the screen frame on each display at its spot when the
  screen was recorded then.
- **Review row**: one thing to review in a meeting: an item or a question, with its Moment, its answer choices and its
  state. The window and the terminal show the same rows in the same order (`src/meetings/lib/review-rows.ts`,
  `tools meetings rows`).
- **Presumed**: the choice of a term that is the best candidate the engine scored, other than its suggested spelling
  and the words as heard. A term with no such candidate has no presumed choice. A review row offers it as a respelling.
- **Decision journal**: the append-only record of who decided what in a meeting, when and why: each confirm, reject,
  respell, answer, skip or rename, with its actor (the window, `listen`, an agent and its session, a rule), its reason,
  and the items it changed before and after under one token that an Undo reverts. Comments sent to the listening agent
  are entries too, which no Undo reverts. An agent that drives the Meetings window through accessibility (macos-control)
  clicks as the window, so the journal records it as the window actor ("you"): the service knows a caller only by the
  hello of its connection.
- **Reason**: why a decision was made, in the decider's words: the window's comment field, `--reason` on a command,
  `listen --comment` on an answer, an agent's stated reason. The decision journal keeps it on the entry, and each item it
  decided keeps it too.
