# Model Room

Model Room is a native macOS workspace for small executable system models. The same TypeScript calculation engine powers the CLI, native window and standalone HTML export.

This feature is under active development. The current implementation includes dimensional formulas, deterministic stocks, explicit delays, measured data, scenario interventions, a native system board, comparison charts, native document editing and interactive offline exports. The broader product specification is not yet complete.

## Open the native window

```bash
tools model-room
tools model-room open support.modelroom.json
tools model-room open support.modelroom.json --data observations.csv
```

The launcher builds and signs GenesisTools.app if its native sources changed. It passes the current checkout's tools executable to the window, so a worktree does not accidentally evaluate models with the main checkout's code. The installed app also records its originating tools checkout; the Hub's Model Room menu uses that origin. If that checkout is removed, the app asks for a rebuild rather than silently switching to another CLI revision.

The window has Build, Explore, Compare and Present modes. Choose a quantity in the outline or board to inspect it. Formula changes apply with Evaluate or Command-Return. The time rail shows each quantity at the selected time, and the chart overlays scenario results.

Use Branch to preserve the baseline. Option-dragging an input slider creates a branch; a slider gesture is one undo transaction. Input values, formulas, added/removed quantities and board positions belong to the selected scenario. Formulas are dimensional: a stock's derivative must have units of stock per time. The inspector also authors slider ranges, provenance and quantity explanations.

The titlebar's model editor has Model, Scenarios and Presentation sections. Edit the clock, branch names/colors, overrides, interventions, exposed controls, result charts and explanation steps. Changes remain in the sheet until **Check and apply** evaluates every branch and records one undoable edit. Cancel leaves the document untouched; a concurrent document change prevents an old draft from replacing it. Structural branch changes can be reset to their baseline definitions.

**Convert all times** preserves physical time while changing its display unit. For example, ten days in daily steps becomes 240 hours in 24-hour steps; observation times, interventions and presentation jumps convert together. Editing a duration or step directly instead changes the simulation schedule.

File commands open/save ordinary JSON documents and export HTML, results CSV or assumptions CSV. Imported observations require an explicit mapping from time and value columns; the preview shows the selected delimiter and the initial records.

## CLI

```bash
tools model-room example support > support.modelroom.json
tools model-room example classroom > classroom.modelroom.json
tools model-room example budget > budget.modelroom.json

tools model-room validate --input support.modelroom.json
tools model-room evaluate --input support.modelroom.json
tools model-room convert-time --input support.modelroom.json --unit hour > hourly.modelroom.json

tools model-room export --input support.modelroom.json --output support.html
tools model-room export --input support.modelroom.json --format results --output results.csv
tools model-room export --input support.modelroom.json --format assumptions --output assumptions.csv
```

Exports refuse to replace an existing file. The native save panel supplies the explicit user-selected destination and stages the new export before committing its bytes. The HTML contains the model, calculation engine and styles, with no external runtime resources. A reader can adjust authored controls and download the exact modified model for further editing.

```bash
tools model-room inspect-table --data attendance.csv --delimiter comma

tools model-room import-data \
  --input classroom.modelroom.json \
  --data attendance.csv \
  --time-column week \
  --value-column attended \
  --id observed_attendance \
  --label 'Observed attendance' \
  --unit people \
  --interpolation hold > classroom-with-data.modelroom.json
```

The preview returns a SHA-256 digest of the table text. Native import passes that digest back; a changed source requires a new preview. CLI callers can use `--expected-sha256 <digest>` for the same check.

Imports print a new model revision without changing either input file. Decimal separators are explicit (`--decimal dot` or `--decimal comma`), and the delimiter can be `comma`, `semicolon` or `tab`. Quoted fields, embedded newlines, escaped quotes, UTF-8 BOM and CRLF records are supported. Malformed records, partially numeric cells, duplicate headers and unsorted time values are rejected.

## Range exploration

Choose **Explore ranges** in the native window. Select one to eight assumptions, their endpoints and sample counts, the scenario to start from, and the final outcome to compare. Completed rows appear while calculation continues. Stop retains those rows, and **Use as scenario** copies a completed run's assumptions into a new editable branch.

The CLI accepts the same explicit configuration:

```json
{
  "axes": [{ "quantityId": "agents", "values": [2, 3, 4, 5] }],
  "outputs": ["backlog"]
}
```

```bash
tools model-room sweep --input support.modelroom.json --config ranges.json
```

Add `scenarioId` to the configuration to start from a branch. The sweep changes input overrides; that branch's scheduled interventions still run. Results report final-time values, rather than an inferred probability. At most 10,000 Cartesian combinations are accepted. `--stream` emits `start`, `run` and `end` JSON-line events and ties cancellation to stdin EOF for native clients. Ctrl-C and the calculation deadline also stop a sweep while retaining completed runs.

## Reusable subsystems

Use **Subsystems → Save subsystem** on Baseline. Select members and exposed results; the sheet identifies changing dependencies that must also be included. Ordinary outside inputs are copied with their values, ranges, units and provenance. Stocks, formulas and measured data are never silently replaced with constants.

Use **Import subsystem** to review a package. Each input either becomes a new assumption or connects to a compatible existing input. Existing inputs supply their values, history and scenario changes. Preview validates the resulting baseline and every branch before **Add to Baseline** records one undoable revision. New identifiers avoid collisions, and imported equations retain their local layout in a free board area.

Packages preserve the source clock. Equivalent units convert automatically, but the physical time step must match the destination to preserve delay semantics. The destination duration remains authoritative. Packages currently carry the baseline, selected data and equations; source scenario branches and presentation explanations are excluded.

~~~bash
tools model-room inspect-subsystem --input support.modelroom.json --members backlog
tools model-room extract-subsystem \
  --input support.modelroom.json \
  --members backlog,capacity \
  --outputs backlog \
  --label 'Support queue' > queue.subsystem.json

tools model-room open other.modelroom.json --subsystem queue.subsystem.json

tools model-room import-subsystem \
  --input other.modelroom.json \
  --subsystem queue.subsystem.json \
  --namespace queue \
  --document-only > combined.modelroom.json
~~~

Without --document-only, import prints a receipt containing the document, identifier mapping, added/bound inputs and exposed outputs. Optional --bindings accepts a JSON object mapping package input IDs to destination input IDs. The CLI leaves both source files untouched. Native preview retains the exact package snapshot it displays.

## Reviewed AI drafts

**Draft with AI** opens a separate review sheet. Describe the model and optionally name a configured ModelRef. Generation sends only that request to the selected model; it uses the existing app/task/account defaults and records reported usage. It never starts automatically when a window opens. Stop cancels the owned operation, and a two-minute generation deadline prevents an indefinite request.

The result is an incomplete proposal, separate from an executable model. Review its relationships and source excerpts, then fill the numeric assumptions. Numbers without an exact matching source excerpt become unanswered questions. That excerpt check does not establish that the number was interpreted correctly. Inline coefficients other than zero and one must be explicit inputs. Model Room checks units, graph structure, clock constraints and a complete numerical run before enabling **Open new model**. The originating document stays unchanged; the result opens as a new unsaved document.

A proposal currently supports up to 24 inputs, formulas and stocks, with at most eight outputs. Generated datasets, scenarios and arbitrary code are excluded. You can extend the reviewed model using the ordinary editor. **Load draft** reads a saved proposal locally without contacting a model.

~~~bash
tools model-room propose --request description.txt > proposal.json
tools model-room review-proposal --proposal proposal.json
tools model-room resolve-proposal --proposal proposal.json --answers answers.json > reviewed.modelroom.json
~~~

The proposal receipt contains the original description, the proposed structure, warnings and missing-field keys. The answers file maps those keys to finite numbers, for example {"unit_cost.value":0.01,"time.duration":10,"time.step":1}. Author answers can also replace cited values. Neither review nor resolution invokes AI; invalid or unresolved proposals produce no model.

## Calculation semantics

- Expressions support numeric literals, named references, `+`, `-`, `*`, `/`, integer powers, parentheses, `min`, `max`, `abs`, `clamp` and `lag`.
- Literal units use brackets: `2[hour] + 30[minute]`.
- Compound units use multiplication, division and integer powers: `tickets/person/day`, `m^2`.
- Dimensionless values use unit `1`; `percent` carries a scale of 0.01.
- Currency units such as USD and EUR are different dimensions. Conversion requires an explicit relationship, not an implicit exchange-rate lookup.
- The engine uses canonical base units internally and converts to the quantity's declared unit for display and export.
- The time-zero frame contains initial stocks. Explicit Euler integration advances each stock using the preceding frame's rates. Optional bounds are applied after each step.
- An intervention at time four changes the interval beginning at time four. It must fall on a simulation step.
- Instantaneous formula cycles are rejected. `lag(quantity, steps)` creates a temporal edge, where steps is an integer from 1 through 10000.
- A delayed formula needs an explicit history seed. Inputs, stocks and data series use their declared initial value unless a separate seed is supplied.
- Measured data uses either hold or linear interpolation. Outside the observed interval, the first or last observation is held; that behavior is visible in the model description.
- Scenarios can override input values, schedule interventions and replace/remove quantities. Build mode edits the selected branch; Compare shows each branch's assumptions and units.
- Comparison charts use the selected quantity's unit. Compatible replacements convert to that scale (300 cm becomes 3 m); absent or dimensionally incompatible quantities are excluded with an explanation. Value readouts retain each branch's declared units.
- Results are IEEE-754 numbers. CSV retains their numeric precision; screen labels round for readability. Integration accuracy depends on the chosen step and model.

The supplied support example starts at 80 tickets, receives 90 per day and has four agents completing 25 tickets each per day. Its baseline falls by ten tickets per day. Three agents instead produce a growing backlog. A day-four self-service intervention reduces arrivals to 65 and changes the direction of that branch.

## Bounds and cancellation

Board coordinates are bounded to 0–8192 points on each axis. Presentation steps stay within the model's time interval. Slider ranges require finite increasing endpoints and a representable positive step. Native document loading checks these constraints before publishing a file into the view tree.

A formula has at most 4096 characters, 512 tokens and 64 nested parsing levels. A model has at most 256 quantities and 10000 time steps. A single run and the ordinary scenario comparison have a two-million-value limit. Documents and observation files are limited to 16 MiB on the CLI/native input paths. Import previews show at most twelve rows, while imported series contain at most ten thousand observations.

Ordinary evaluation has a deadline, and a sweep contains at most ten thousand runs. Cancellation keeps complete sweep results and discards an incomplete run. The native window cancels superseded calculations and rejects a result from an older document revision. Invalid formulas preserve the last valid display with a stale-result indicator.

Native chart samples are prepared away from the UI thread and retain endpoints and bucket extrema; exact frames remain available to the time rail and exports. The render budget is shared across the model's plotted series. Browser chart downsampling, richer explanations and additional numerical techniques remain release work. These limits do not imply that every maximum-size model already meets an interactive performance target.

## Verification

```bash
bun run test src/model-room/lib/model-room.test.ts src/spotify/tests/csv.test.ts
bun run tsgo
bunx biome check src/model-room src/utils/quantities src/utils/tabular src/spotify/lib/csv.ts
```

Native model tests are in `src/macos/GenesisTools/Tests/ModelRoomTests.swift`. Run `swift test --filter ModelRoomTests` from that package. After native source changes, use `bun run app` from the repository root and inspect the rendered app.

The native face supports deterministic captures with `--model-room --snapshot <png>`, plus `--mode build|explore|compare|present`, `--tick <n>`, `--example support|classroom|budget`, `--open <file>`, `--width <points>` and `--tools <absolute tools executable>`. A snapshot runs without activation and fails if no valid result renders before its deadline.
