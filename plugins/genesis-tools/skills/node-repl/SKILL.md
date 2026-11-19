---
name: node-repl
description: Drive GenesisTools from a persistent JavaScript REPL (tools node-repl, its MCP server and toolsets such as computer, movies, recorder, meetings, browser) and keep scripts that worked as named presets with parameters that run again with other values. Use for "run this in the node repl", "which toolset has X", "save this script as a preset", "run the preset again with another url", "list my presets", or before writing a multi-step agent script against the native control, recorder or browser APIs.
---

# Node REPL: toolsets and presets

`src/node-repl/README.md` is the full reference (`tools node-repl --readme`). Inside a turn, `help()`, `search("cut")`
and `describe("movies.demo")` print the loaded toolsets' real signatures; read them before you guess a parameter.

## Toolsets

Load what the task needs: `tools node-repl mcp --toolset movies,computer,presets` (or `run --toolset …` for one turn
in a fresh process). Bindings survive between `js` calls of the MCP server, never between `run` calls.

### Meetings

| REPL call (await the result) | CLI command |
| --- | --- |
| `meetings.applySeats({ meeting, room, remote, replace })` | `tools meetings seats <meeting> --apply` (use `--replace` for saved seats) |
| `meetings.backfillVoices({ project, dryRun: true })` or `meetings.backfillVoices({ meetings: [meeting], dryRun: true })` | `tools meetings voices backfill --project <p> --dry-run` or `tools meetings voices backfill <meeting> --dry-run` |
| `meetings.seats({ meeting })` | `tools meetings seats <meeting> --json` |
| `meetings.thresholds({ meeting, set: { "term.applyAbove": 0.8 }, preview: true })` | `tools meetings thresholds <meeting> --set term.applyAbove=0.8 --preview --json` |
| `meetings.voiceReadiness({ meeting })` | The `voice` field of `tools meetings show <meeting> --json` |
| `meetings.voices({ scope: "project", project })` | `tools meetings voices --project <p> --json` |

The callable voice browser also takes `{ scope: "meeting", meeting: id }` for one meeting or `{ scope: "global" }` for all projects. Each scope accepts a `person` filter.
To preview or apply a timed seat, pass `room: [{ name, fromSec: 30, toSec: 90 }]` to
`meetings.seats` or `meetings.applySeats`. A stay includes its start and ends just before its leave time.

| REPL call (await the result) | CLI command |
| --- | --- |
| `meetings.lineEligibility({ meeting, line: 3 })` | `tools meetings evidence <meeting> --line-eligibility 3 --json` (fourth transcript line) |
| `meetings.measure({ meeting })` | `bun scripts/benchmarks/meetings/room-call.ts --reference "$bundle/reference.json" --holdout "$bundle/holdout.json" --baseline "$bundle/baseline.json" --candidate "$bundle/candidate.json" --out "$report"` |
| `meetings.voices.list({ scope: { kind: "meeting", meeting }, person })` | `tools meetings voices --meeting <meeting> --person <person> --json` |
| `meetings.voices.samples({ project, person })` | `tools meetings voices samples <person> --project <p> --json` |
| `meetings.voices.move({ id, person, to: { name } })` | `tools meetings voices move <person> --sample <id> --to <name>` |
| `meetings.voices.quality({ project, person })` | `tools meetings voices quality --project <p> --person <person> --json` |
| `meetings.voices.reject({ id, person, reason: "bad-audio" })` | `tools meetings voices reject <person> --sample <id> --reason bad-audio` |
| `meetings.voices.remove({ id, planToken })` | `tools meetings voices remove <person> --sample <id> --plan-token <token>` |
| `meetings.voices.sample({ id })` | `tools meetings voices play <person> --sample <id> --no-start --json` |
| `meetings.voices.play({ id })` | `tools meetings voices play <person> --sample <id>` |
| `meetings.voices.undo({ token })` | `tools meetings voices undo <correction-token>` |

For `measure`, `bundle` is the meeting record's adjacent `room-call/` folder. The REPL returns the comparison of
held-out speaker predictions directly. The script takes a new output path in `report` and writes the same JSON there.

Read the `id` from the listed sample. Playback accepts `player` to choose a player or `start: false` to return the verified slice silently.
To preview a move, rejection or removal in the REPL, add `preview: true`. To confirm, call it again with
the preview's `planToken` and omit `preview`. Undo takes the applied receipt's `token`.

## Presets (save a script that worked, run it again)

1. Get the script right in the REPL first. A preset is the body of an async function: it reads `params` and `return`s
   its result.
2. Save it: `await presets.save("signup-demo", { script, description, params: { url: { type: "string", default:
   "https://example.org" }, steps: { type: "number" } } })`. A param with no default is required at every run;
   `toolsets` defaults to those the script names (`movies.`, `computer.`).
3. Run it with other values: `await presets.run("signup-demo", { url: "https://staging.example.org" })` in the REPL,
   or `tools node-repl preset run signup-demo --param url=https://staging.example.org` from a shell (a fresh REPL with
   the preset's toolsets). An unknown or missing value is refused before anything runs.
4. `presets.list()` / `tools node-repl preset list` shows each preset's params and run count;
   `presets.remove(name)` / `preset rm` moves it to `.trash/`.

A recorder demo is the usual preset: `movies.demo({ steps })` with the varying parts (a URL, a pane, a title) as params
(the recorder skill, "Demo mode").
