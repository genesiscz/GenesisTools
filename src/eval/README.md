# Project scenario evaluations

`tools eval` mounts the portable conversation engine for one explicitly selected trusted local project module. The module exports a named `project` from `defineEvalProject`. Loading it executes its code, so select only project code you trust. There is no registry, global config lookup or automatic project discovery. The project's own scenario directory, if declared, remains its explicit choice.

Put `--project` before the engine command. Paths may be relative to the current directory or absolute. URL imports are refused by the host.

```bash
./tools eval --project ./src/eval/projects/mini-agent.ts check --print
./tools eval --project ./src/eval/projects/mini-agent.ts list
./tools eval --project ./src/eval/projects/mini-agent.ts run --matrix offline
./tools eval --project ./src/eval/projects/mini-agent.ts run --resume <run-id>
./tools eval --project ./src/eval/projects/mini-agent.ts show <run-id>
./tools eval --project ./src/eval/projects/mini-agent.ts compare <earlier-run> <later-run>
```

The bundled mini-agent uses a deterministic offline transport. It looks up a task and completes it only after a second confirming turn. The record includes ordered tool calls, tool inputs/outputs and schema-validated signals. It makes no model or network calls. Its reported cost is synthetic accounting, 0.01 USD per turn, so cost-stop and resume can be exercised without spending money.

By default the project writes runs beneath `.evals/runs` in the current directory. To choose an explicit output folder, export a project in your own trusted module:

```ts
import { project as offline } from "/absolute/GenesisTools/src/eval/projects/mini-agent";
export const project = { ...offline, runsDir: "/absolute/private/eval-runs" };
```

`check` and `list` without `--live` validate or list the project without connecting its system or creating run folders. Every engine result is one strict JSON document on stdout. Progress is emitted on stderr only with `--progress`. `show <run> <conversation> --text` prints the transcript as text. Exit precedence is usage 2, safety failure 3, behavior failure 1, then no verdict 4.

The host uses GenesisTools `out`, `withInterrupt` and `runTool`. It passes the abort signal through `EvalIo`; the portable engine does not need a GenesisTools import. The public system contract and all engine commands are described in [the portable core README](../utils/eval-engine/README.md).

```bash
bun scripts/test.ts src/utils/eval-engine src/eval
```

The core retains its zod, commander and Node-only import boundary and a narrowly scoped strict-JSON policy exception. The files carry no provenance header, since one held a home path and a private project name; `git log -- src/utils/eval-engine` records where each version came from. Subsequent canonical versions are vendored back from a selected committed GenesisTools version without reformatting the copied bytes.
