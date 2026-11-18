---
paths:
  - "src/meetings/**"
  - "src/utils/meetings/**"
  - "src/recorder/**"
  - "src/utils/recording-editor/**"
  - "src/utils/screen-recorder/**"
  - "src/macos/GenesisTools/Sources/Parts/Meetings/**"
  - "src/macos/GenesisTools/Sources/Parts/Recorder/**"
  - "src/macos/GenesisKit/Sources/GenesisKit/Recording/**"
  - "src/node-repl/**"
  - "src/utils/repl/**"
  - ".claude/plans/*Meetings*.md"
  - ".claude/plans/*Recorder*.md"
  - ".claude/plans/*Recording*.md"
---

# Meetings and recorder features reach the node REPL in the same change

Loaded by Claude Code when you read, write or edit a file of the meetings tool, the recorder, the recording editor or
the node REPL. Agents drive these tools through `tools node-repl` (skill `genesis-tools:node-repl`), not only through
the CLI and the windows. A feature that only the CLI or a window has is a feature an agent cannot script.

Observed defect, 2026-11-18: seats (`tools meetings seats`), voice backfill and readiness, and the threshold preview
shipped as CLI commands and service methods with no entry in the REPL's `meetings` toolset; the live recorder RPC had
`target.switch` and `restart` with no method on the REPL's recording handle. Nobody planned the REPL side, so nobody
built it.

## The rule

1. A new or changed CLI command, service method, RPC method or editor op in these folders gets its REPL door in the
   same package or commit:
   - meetings: a method in `meetingsToolsetApi` (src/meetings/lib/service/toolset-api.ts) and its binding in
     src/node-repl/lib/toolsets/meetings.ts;
   - live recording: a method on `RecordingHandle` (src/utils/repl/toolsets/recorder.ts);
   - recording editor ops: a named method on the `movies` toolset's Movie handle (src/recorder/lib/toolset.ts), beside
     the generic `apply(ops)`;
   - frames editing: src/utils/repl/toolsets/editor.ts.
2. The REPL method calls the same library function or service method as the CLI. It never copies the logic.
3. Its `doc` string says what it returns and names the CLI twin, so `describe("meetings.<name>")` answers an agent.
4. A test covers it where the toolset tests live (src/node-repl/lib/toolsets.test.ts, "toolset method names", or the
   owner's existing test file). Do not add a new test file for one method (`.claude/rules/tests.md`).
5. The skill that teaches the feature (`plugins/genesis-tools/skills/meetings/`, `.../recorder/`,
   `.../node-repl/`) names the REPL call next to the CLI command.

## In a plan

Every build spec for these folders lists, per package, the REPL door it adds (rule 1) in its owner files and its
"Done when". A package that adds no CLI, service, RPC or op says "REPL: none" so the omission is visible. A reviewer
who finds a new command without its REPL door treats it as an unfinished package, not a follow-up.
