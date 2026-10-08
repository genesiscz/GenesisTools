# Show Once

Show Once records a browser report task, exposes its actions and evidence as an editable native workflow, then replays it with new inputs and checks the actual file output.

Open the native window with `tools show-once`. Choose an installed browser, enter its start page, and click **Open recording browser**. This opens a separate window with a fresh profile and fills the connection port. Sign in there if needed, then select its exact tab. **Find tabs** with an empty port discovers existing debugger connections; you can also enter a known port. Select separate download and destination folders. Record the customer/month/report changes and download. Wait for **Download content captured**, rename and move the file into the destination, and stop recording. The app connects the completed download to one new destination file by SHA-256.

Inspect the workflow before running it. Select a fill or select step and add an input parameter. Use references such as `{{customer}}`, `{{month}}`, `{{report}}`, and `{{destination}}` in changing values, filenames, destinations, and required-content checks. A content check such as `{{customer}},{{month}},{{report}},42` verifies the CSV's actual data. Add checkpoints when a person must inspect another result.

The native window provides a step list with source evidence, target/value/file/check editing, ordering and deletion, an input form, progress and cancellation, explicit target repair, saved workflows, JSON inspection, import/export, and retained run receipts. Source evidence keeps the original nonsecret field values, target identities, download filename, and hash after parameterization. Repair fields expose the expected tag, role, and accessible name while retaining the demonstrated target. Imported JSON is validated before use. Runtime secret values are requested through secure input fields and never saved in portable recipes or receipts. Secret references are supported only as whole fill values.

## CLI and MCP

All three doors use the same service and runner:

```sh
tools show-once open /absolute/report.showonce.json
tools show-once validate /absolute/report.showonce.json
tools show-once tabs --port 9222
tools show-once run /absolute/report.showonce.json \
    --port 9222 \
    --target EXPLICIT_TAB_ID \
    --inputs /absolute/runtime-inputs.json
tools show-once history /absolute/report.showonce.json
tools show-once mcp
```

`runtime-inputs.json` supplies named inputs, for example `{"customer":"shop","month":"2026-10","report":"sales","destination":"/absolute/reports"}`. Destinations must already exist. CLI checkpoints require explicit `--approve-checkpoints`; the native window and resident MCP service can acknowledge an exact checkpoint with `resume` and its run/step IDs.

The MCP server advertises `show_once`. Its `op` accepts `browsers`, `open-browser`, `tabs`, `record-start`, `record-stop`, `validate`, `save`, `open`, `run`, `cancel`, `resume`, `status`, and `history`. `run` takes validated recipe data, runtime inputs, debugger port, and an explicit target ID. `save` writes the inspectable JSON that `open` returns. The native JSON-lines bridge uses the same commands.

`tools show-once demo` serves a disposable local report fixture and prints its URL. `record` also supports a bounded terminal recording with explicit tab, folder, duration, and output flags; see `tools show-once record --help`.

## Supported scope

The first release supports main-frame browser navigation, unique semantic targets, fill/select/click/key actions, one observed report download, and rename/move of that verified file. Test IDs and role/name targets are preserved. CSS fallbacks additionally require the recorded tag, role, and name fingerprint. Replays reject stale documents, changed identities, hidden/disabled controls, missing targets, and multiple matches before dispatch.

A recording with multiple possible download clicks requires explicit trigger review. Unsupported enabled steps prevent replay before any action. Password, payment, file, and obviously credential-labeled input values are omitted from recordings; warnings remain visible. A tab admits one recorder at a time, and replay refuses a tab owned by a recording before changing its download routing or inputs. Arbitrary Mac app recording, frames, drag gestures, and coordinate-only replay are outside this release.

Browser download routing temporarily applies to the browser context while the task runs and is restored to its default afterward. Finish unrelated downloads before recording or replaying. Only the selected main frame's completed downloads count as workflow evidence. Choose folders with at most 1000 entries; content verification supports regular files up to 20 MB. A file moved before its download hash is captured becomes an unsupported move requiring review.

Actions whose delivery may have started are never retried automatically. Receipts distinguish refusal, delivery, verified readback, and uncertain outcomes. A captured hash establishes file integrity; semantic content is checked only against the required-content rules you configure, and the receipt states when no rule was configured. File moves refuse collisions and symlink paths, create the destination exclusively, check content and hashes, and remove the source only after successful readback. Cancel stops owned waits and sockets; it does not undo an already dispatched browser action or committed file operation.

## Verification

Run the consolidated unit suite through the repository wrapper:

```sh
bun run test src/show-once/lib/show-once.test.ts
```

Run the actual disposable-browser acceptance harness:

```sh
bun run src/show-once/scripts/acceptance.ts
```

The harness uses trusted browser input, records the report actions, observes a real filesystem rename representing the Finder move, saves/reopens the recipe, and exports it through actual CLI and stdio MCP runs with two distinct parameter sets. It checks output paths and CSV content, missing/ambiguous/stale/changed-target refusals, explicit repair, cancellation deadlines, and retained run receipts. It preserves raw evidence in a session scratch directory. The native Finder interaction is a separate signed desktop acceptance gate.
