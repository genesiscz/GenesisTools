<!-- Copied from /Users/Martin/Tresors/Projects/Kalendora/src/eval-engine/README.md at 2026-11-12T06:18:59+01:00 at commit hash 2b9937db296fcb22d402376689d926a71fe9f165 -->
# eval-engine

A project-agnostic engine that plays scenario conversations against a system, checks every answer, and writes a
transcript of each conversation. It knows nothing about the project that uses it. It imports only `zod` (v4),
`commander` (v15), Node's built-ins and its own files; `boundary.test.ts` fails on anything else, so another project
can copy the folder as it is.

A project writes four things: a **system** (how to open a conversation, send a turn, and read back the answer, the
tool calls and its own facts, the "signals"), a **kit** (typed definition functions), **scenarios**, and a
**project** (the parts together). The engine gives it a command line, run folders, verdicts, pass rates, resume,
and compare.

## Quickstart for another project

The example is a help desk agent. It type-checks against this folder (checked 2026-11-10 18:52).

```ts
// evals/system.ts
import { z } from "zod";
import { defineEvalSystem, EvalSystemError } from "@genesiscz/utils/eval-engine";

interface Conversation {
  model: string;
  customer: "new" | "vip";
  history: { role: "user" | "assistant"; content: string }[];
}

export const HelpdeskSystem = defineEvalSystem({
  name: "helpdesk",
  tools: ["lookup_order", "refund_order", "escalate"],
  setup: z.object({ customer: z.enum(["new", "vip"]).default("new") }),
  // The signals MUST be a z.object: the engine checks every signal path a scenario uses against its keys.
  signals: z.object({
    refunded: z.boolean(),
    escalated: z.boolean(),
    order: z.object({ id: z.string(), total: z.number() }).nullable(),
  }),
  // Bump it when the code that computes the signals changes meaning.
  signalsVersion: 1,
  connect: (target) => ({
    describe: async () => ({
      models: [{ id: "gpt-5-mini", label: "GPT-5 mini", limitKey: "openai" }],
      variants: ["current"],
      fingerprint: null,
    }),
    open: async ({ model, setup }): Promise<Conversation> => ({ model: model.id, customer: setup.customer, history: [] }),
    send: async (conversation: Conversation, text: string) => {
      const started = Date.now();
      conversation.history.push({ role: "user", content: text });
      const answer = await callModel(conversation.model, conversation.history); // your code
      if (answer.status === 429) throw new EvalSystemError("rate-limit", "429", { retryAfterMs: 5000 });
      if (answer.status >= 500) throw new EvalSystemError("transient", `HTTP ${answer.status}`);
      if (answer.status === 401) throw new EvalSystemError("blocked", "no API key");
      conversation.history.push({ role: "assistant", content: answer.text });
      return {
        reply: answer.text,
        toolCalls: answer.toolCalls, // [{ name, input, output?, error? }]
        signals: {
          refunded: answer.toolCalls.some((call) => call.name === "refund_order"),
          escalated: answer.toolCalls.some((call) => call.name === "escalate"),
          order: answer.order, // { id, total } or null
        },
        usage: { inputTokens: answer.inputTokens, outputTokens: answer.outputTokens },
        latencyMs: Date.now() - started,
      };
    },
    close: async () => {},
  }),
});

// evals/kit.ts
import { evalKit } from "@genesiscz/utils/eval-engine";
export const { defineEvalScenario, defineEvalMatrix, check } = evalKit(HelpdeskSystem);

// evals/scenarios/refunds.eval.ts
export const RefundAsked = defineEvalScenario({
  id: "refund-asked",
  title: "A refund is made only after the order was looked up",
  tags: ["regression"],
  setup: { customer: "vip" },
  steps: (s) => [
    {
      user: "Hi, I want my money back for order A-1.",
      expect: [
        s.safety("no-refund-without-lookup", s.not(s.allOf(s.tool("refund_order"), s.not(s.tool("lookup_order"))))),
        s.gate("acts", s.anyOf({ looks: s.tool("lookup_order"), asks: s.noTools() })),
        s.advisory("polite", s.judge("The reply is polite.")),
      ],
    },
    {
      choose: [
        { name: "looked", when: s.signal("order", { exists: true }), bind: { order: "order" }, user: "Yes, the {{order.total}} EUR one." },
        { otherwise: true, user: "It is order A-1." },
      ],
    },
  ],
  final: (s) => [s.gate("refunded", s.signal("refunded", { is: true }))],
});

// evals/matrices.ts
export const Regression = defineEvalMatrix({ id: "regression", scenarios: { tags: ["regression"] }, models: ["gpt-5-mini"], repeats: 5 });

// evals/project.ts
import { defineEvalProject } from "@genesiscz/utils/eval-engine";
export const HelpdeskEvals = defineEvalProject({
  system: HelpdeskSystem,
  scenarios: { dir: new URL("./scenarios/", import.meta.url) },
  matrices: [Regression],
  harness: { judge: "gpt-5-mini" }, // needs `complete` in the connection; without it judge checks are inconclusive
  concurrency: 4,
});

// bin/evals.ts
import { createEvalCommand } from "@genesiscz/utils/eval-engine";
await createEvalCommand(HelpdeskEvals, { description: "AI evals of the help desk" }).parseAsync();
```

`createEvalCommand` returns a commander `Command` named `eval`. Mount it with `program.addCommand(...)`, or parse it
on its own as above.

### The system contract (`system.ts`)

| Member | What the engine does with it |
|---|---|
| `name`, `tools`, `setup`, `signals` | The vocabulary. Scenarios are validated against it with nothing running. `tools` and the signal keys also type the builder, so an unknown name is a compile error. |
| `signalsVersion` | Stored in the manifest. `compare` leaves a scenario out across a change; `--resume` refuses one. |
| `resolveSetup(setup, { now })` | Optional. Called once per scenario when the run is planned; the result goes to `open`, into the manifest, and is reused on `--resume` (resolved again with the stored planning time, and it must give the same JSON). It must return plain JSON. Leave it out to pass the setup as it is. |
| `connect(target)` | `target` is the CLI's `--target`, or undefined. |
| `describe()` | Models (`id`, `label`, `limitKey`), prompt variants (the first is "the system as it is now"), a `fingerprint` (a commit). Read once per run. |
| `open({ model, variant, setup, runId, key, signal })` | A new, empty conversation. Tag what you create with `runId`, so `cleanup` can find it. |
| `send(handle, text, { signal })` | One user turn, called exactly once per turn. Returns `TurnResult`: `reply`, `toolCalls`, `signals`, `usage` (with `costUsd` when you know it), `latencyMs`, optional `toolEvidence: "unavailable"`, `systemPrompt`, `context`, `observedModel`, `steps`, `firstTokenMs`. |
| `close(handle, outcome)` | Always called once per opened conversation, with `"passed"`, `"failed"`, `"inconclusive"` or `"discarded"`. Keep failed conversations for a person if you like. An error here is noted in the record and changes nothing. |
| `complete(request)` | Optional. One text completion for the judge (`purpose: "judge"`) or the simulated user (`"simulator"`), on a model id from `describe`. |
| `cleanup({ runId?, signal })` | Optional. Removes what runs left behind; returns `{ removed: [{ id, runId?, description? }] }`. |

**Errors.** Throw `EvalSystemError` for anything that is not the model's behaviour: `"rate-limit"` (with
`retryAfterMs` when the provider said so), `"transient"` (a 5xx, a dropped stream, a timeout) or `"blocked"` (a
missing key, an unknown model: retrying cannot help, the whole cell stops). Any other thrown error counts as
`"transient"`. Signals that do not parse with your schema count as `"blocked"`.

## The scenario language

A scenario is one JSON document. The builder (`steps: (s) => [...]`) only writes that document with types; it runs
once, when the file is loaded. So a scenario can be printed, hashed, compared and sent on stdin.

### Checks

| Check (JSON) | Builder | Passes when |
|---|---|---|
| `{ "tool": "x", "args": {...}, "times": { "min": 1, "max": 2 } }` | `s.tool("x", args?, times?)` | `x` was called with matching arguments between `min` (default 1) and `max` times |
| `{ "onlyTools": ["a", "b"] }` / `{ "onlyTools": [] }` | `s.onlyTools("a", "b")` / `s.noTools()` | no other tool (no tool at all) was called |
| `{ "text": { "contains": "x" \| ["x", "y"], "caseSensitive": false } }` or `{ "text": { "matches": "re", "flags": "i" } }` | `s.text(...)` | some reply in scope matches (case-insensitive by default) |
| `{ "signal": "path", <matcher> }` | `s.signal("path", matcher)` | the signal at the path matches |
| `{ "judge": "question" }` | `s.judge("question")` | the judge model answers yes; "cannot tell" or a failing judge is inconclusive |
| `{ "anyOf": { "name": check, ... } }` or `{ "anyOf": [check, ...] }` | `s.anyOf({ name: check })` / `s.anyOf([a, b])` | some branch passes; the verdict names the first branch that passed (a list's branches are named "1", "2", …) |
| `{ "allOf": [check, ...] }` | `s.allOf(a, b)` | every child passes |
| `{ "not": check }` | `s.not(check)` | the child fails (inconclusive stays inconclusive) |

**Matchers** (exactly one): `{ "is": json }` (deep equality), `{ "oneOf": [json, ...] }`, `{ "matches": "re", "flags": "i" }`,
`{ "min": n, "max": n }`, `{ "size": { "min": n, "max": n } }` (length of a list or a string),
`{ "instant": "2026-11-16T08:00:00Z" }` (the same moment, any ISO spelling), `{ "exists": true | false }` (present and
not null). An argument leaf in `args` is a literal (deep equality) or a matcher; to match a literal object that looks
like a matcher, write `{ "is": {...} }`.

**Signal paths:** `name`, `name.field`, `name[1]`, `name[1].field`. Every path is checked against the signals' zod
object when the scenario is loaded (through optional, nullable and default wrappers, into objects and arrays), and an
unknown name is an issue with the list of known names.

**Results are three-valued:** pass, fail, inconclusive. Code checks run before judges, and a judge is asked only when
its answer can still change the result (a passing code branch of an any-of costs no judge call).

### Expectations and severities

An expectation is `{ "id": "...", "severity": "safety" | "gate" | "advisory", "check": ... }`. In JSON, `id` defaults
to `s1.e1` (step 1, expectation 1; `a1` for `always`, `f1` for `final`, `s2.<branch>.e1` in a choose branch) and
`severity` to `gate`.

- **safety**: one miss in any repeat fails the cell whatever its pass rate, and the run exits with 3. **A safety
  expectation takes only checks that code decides**: a judge under `s.safety(...)` does not compile, and a JSON
  scenario with one is refused with the issue's path.
- **gate**: a failure fails the conversation; the cell passes when its pass rate reaches its threshold.
- **advisory**: recorded and counted, never changes an outcome.

Where an expectation stands gives its scope: in a step's `expect` (that turn), in `always` (every turn; the project's
`always` list is appended to every scenario, and is part of its hash), in `final` (once after the last turn, on the
whole conversation: every tool call and reply, and the last turn's signals).

### Steps

```json
{
  "id": "picks-second-time",
  "title": "The user picks the second offered time",
  "tags": ["regression"],
  "setup": { "locale": "cs" },
  "passRate": 0.8,
  "steps": [
    { "user": "I need an appointment this week.",
      "expect": [{ "check": { "signal": "offered", "size": { "min": 2 } } }] },
    { "bind": { "pick": "offered[1]" },
      "user": "I take {{pick.label}}.",
      "expect": [{ "id": "books-pick", "check": { "tool": "book_appointment", "args": { "starts_at": { "instant": "{{pick.startsAt}}" } } } }] },
    { "choose": [
        { "name": "asked", "when": { "onlyTools": [] }, "user": "Tomorrow morning." },
        { "otherwise": true, "user": "Thank you." } ] },
    { "simulate": { "persona": "You are a patient who writes short messages.", "goal": "Book a check-up.", "maxTurns": 6,
                    "until": { "tool": "book_appointment" } } }
  ],
  "always": [],
  "final": [{ "check": { "signal": "booking.startsAt", "instant": "{{pick.startsAt}}" } }]
}
```

- **Scripted step**: `user`, optional `bind`, optional `expect`.
- **`bind`** reads paths in the PREVIOUS turn's signals; `{{name.path}}` then reads the bound value in the user text
  and in later checks (a string that is one template alone keeps the value's type). A binding that cannot be read is
  a gate failure of the previous turn (id `binding:<name>`) and stops the conversation. The first step cannot bind.
- **`choose`**: the next user turn is picked by checks on the previous turn. The first branch whose `when` passes is
  played (`when` takes code checks only), else the `otherwise` branch, which must be last. The transcript records
  the branch name (`name`, default the 1-based position or "otherwise"). No branch matching and no `otherwise` is a
  gate failure `choose:s<n>` of the previous turn. Bindings made in a branch are visible only inside that branch.
- **`simulate`**: turns written by a simulated user (the project's `harness.simulator` model through `complete`),
  until `until` passes (code checks only), the simulator writes `###STOP###`, or `maxTurns` (1 to 20).
- A conversation stops at its first gate or safety failure (`--keep-going` plays every step).

Unknown keys are refused, so a typo is never ignored. `check --print` shows the document with every default filled
in, and its hash (sha256 of the canonical JSON, 16 hex).

### Matrices

`{ id, scenarios: "all" | ["id", ...] | { tags: ["t"] }, models: [...], variants?: [...], repeats, passRate?: 1,
maxErrorRate?: 0.1, maxCostUsd? }`. A cell is scenario × model × variant; it plays `repeats` conversations. A tag
selection takes every scenario with at least one of the tags. A scenario's own `passRate` wins over the matrix's.

## Commands

Every command prints exactly one JSON document on stdout (`show … --text` prints text) and sets the exit code.
Progress goes to stderr as JSON lines, only with `--progress`.

| Command | Flags | Prints |
|---|---|---|
| `run [scenarios...]` | `--matrix <id>`, `--tag <tag...>`, `--model <id...>`, `--variant <name...>`, `--repeats <n>`, `--stdin`, `--resume <run>`, `--concurrency <n>`, `--max-cost-usd <usd>`, `--target <t>`, `--label <label>`, `--all-cells`, `--keep-going`, `--failures <n>`, `--progress` | `eval-run/1` |
| `say <text...>` | `--model <id>` (required), `--variant <name>`, `--repeats <n>`, `--setup <json>`, `--target <t>`, `--concurrency <n>` | `eval-say/1`: each reply, its tool names and signals; no expectations, no run folder |
| `check [scenarios...]` | `--print`, `--stdin`, `--matrix <id>`, `--tag <tag...>` | `eval-check/1`: ids, hashes, resolved setups (and documents with `--print`); contacts nothing |
| `list` | `--live`, `--target <t>` | `eval-list/1`: scenarios, matrices (and the system's models and variants with `--live`) |
| `runs` | `--limit <n>` | `eval-runs/1`: run folders, newest first, with their verdicts |
| `show <run> [conversation]` | `--text`, `--all-cells`, `--failures <n>` | `eval-run/1` folded from the records, or one `eval-conversation/1` transcript |
| `compare [a] [b]` | `--last 2` | `eval-compare/1` |
| `cleanup` | `--run <id>`, `--target <t>` | `eval-cleanup/1`: what the system removed |

- `run`: `--model` overrides the matrix's models, `--variant` its variants (default: the system's first variant),
  `--repeats` its repeats (default 1), `--max-cost-usd` its cap. `--stdin` takes one scenario or an array; the
  project's `always` list is appended to them too.
- `run --resume <run>` plays only the conversations that have no result, with the stored plan, scenarios and
  resolved setups. Beside it only `--concurrency`, `--max-cost-usd`, `--keep-going`, `--all-cells`, `--failures` and
  `--progress` are allowed.
- `--concurrency` (default: the project's `concurrency`, else 4) bounds the open conversations and is the top of
  every adaptive limit.
- `--max-cost-usd`: once the finished conversations of the run cost more than this, no new conversation opens. The
  keys left have no result (`errors/` says `cost-limit`), and `stopped` in the output says why.
- `compare --last 2` compares the two newest run folders (by id).

On a wrong call every command prints
`{ "schema": "eval-error/1", "error": "<code>", "message": "...", "issues": [{ "path": "0.steps.0.expect.1.check.tool", "message": "unknown tool \"find_slots\"; known: …" }] }`
with exit 2. Codes: `bad-option`, `invalid-scenario`, `invalid-matrix`, `unknown-scenario`, `unknown-model`,
`unknown-variant`, `unknown-matrix`, `unknown-run`, `plan-changed`, `unsupported`. An unreachable system prints
`error: "system-unavailable"` with the `kind` and exits 4.

### `eval-run/1`

`{ schema, run, dir, target, verdict: "passed" | "failed" | "safety-failed" | "errored", exitCode, totals: { planned,
passed, failed, inconclusive, errored, systemCostUsd, harnessCostUsd, durationMs }, cells, cellsPassed, failures,
failuresOmitted, stopped, warnings }`.

- `cells` holds the cells that did not pass (every cell with `--all-cells` or when there is one): `scenario, model,
  variant, n, passed, failed, inconclusive, errored, passRate, threshold, safetyMisses, verdict, promptHash`, and
  `branches` (expectation id → any-of branch → how often it passed) when an any-of passed.
- A cell verdict is the first that applies: `safety-failed` (a safety miss); `failed` (a proven failure: even if
  every conversation without a result had passed, the cell stays below its threshold); `errored` (nothing finished,
  or more conversations without a result than `maxErrorRate`); `failed` or `inconclusive` (below the threshold);
  `inconclusive` (a safety check that could not be decided); `passed`.
- `failures`: at most 5 (`--failures`), safety first, one per failed conversation, each with its transcript path.

### `eval-compare/1`

`{ schema, a, b, comparable, verdict: "same" | "improved" | "regressed" | "new-safety-miss" | "not-comparable",
exitCode, prompt, cells, unchanged, excluded, excludedExpectations, notes }`.

## Exit codes

| Code | `run` | `compare` |
|---|---|---|
| 0 | every cell passed | no cell regressed |
| 1 | a cell failed or is inconclusive | a cell regressed |
| 2 | the call is wrong (bad flag, invalid scenario, unknown model, changed plan on `--resume`) | nothing comparable |
| 3 | a safety expectation failed | a new safety miss |
| 4 | no verdict: the system is unreachable, or a cell had too many conversations without a result | |

When several apply, the first in this order wins: 2, 3, 1, 4. A proven failure outranks "no verdict".

## The run folder

`.evals/runs/` by default (`runsDir` in the project). A run id is local time to the second plus a label
(`2026-11-10T19-50-12-regression`), so folders sort by time.

```text
<runsDir>/<run>/
├── manifest.json        written once, never changed (also not by --resume): schema "eval-manifest/1", the plan
│                        (cells with scenario hashes and thresholds, conversation keys, plan hash), every scenario
│                        document, the resolved setups and the planning time, the system's info, the judge and
│                        simulator with their prompt versions, rubric and signals versions, maxCostUsd, argv
├── conversations/       one file per finished conversation, <scenario>~<model>~<variant>~r<n>.json, created once
│                        (temporary file + hard link) and never replaced: schema "eval-conversation/1"
├── errors/              <key>.jsonl: one line per attempt that ended without a record (kind, message, time)
├── prompts/             <hash>.txt: each distinct system prompt once
└── summary.json         an export of the last run output; no command reads it
```

A transcript holds per turn: the user text and its source (script or simulator), the `choose` branch, the reply,
each tool call with input and output, the signals, the prompt hash, the context, the model's steps, tokens, cost,
latency, and every verdict with its check tree, reason and passing branch.

## Rules

- **Safety is deterministic.** A safety expectation, a `choose.when` and a `simulate.until` take only checks that code
  decides. The type and the JSON validation both refuse a judge there.
- **Behaviour is never retried.** A conversation that returned a record is final, whatever its outcome. Only an
  infrastructure error (`EvalSystemError` "rate-limit" or "transient", or any other thrown error) retries, and the
  unit of retry is the whole conversation: a new `open`, never a second `send` of a turn. "blocked" stops the cell.
  At most 3 conversations per key (`maxAttempts` in the project).
- **A proven failure survives a later infrastructure error.** A conversation that failed a check and then lost its
  stream is written as a failed record and never played again.
- **Limits.** Each `limitKey` has an adaptive limit: it starts at the concurrency, halves on a rate limit (never below
  1), pauses the key for `retryAfterMs` (or 1 s, 2 s, 4 s … up to 60 s), and grows by one after five successes in a
  row. Judge and simulator calls pass the limiter of their model too. Nothing is shared between processes.
- **What `compare` refuses.** Per scenario: a scenario whose document hash differs (`scenario-changed`), or all
  scenarios when the signals or rubric version differs (`signals-changed`, `rubric-changed`), are left out with the
  reason. A cell in one run only is left out (`only-in-a`, `only-in-b`). When the judge model or the judge prompt
  version differs, only the expectations that contain a judge are left out (`excludedExpectations`); their cells are
  still compared on the rest. A cell is `fixed` or `regressed` only when its verdict flips; a moved pass rate is
  `rate-changed`, never "improved". A changed system prompt or fingerprint is listed, never a refusal.
- **Records are the truth.** `show`, `runs` and `compare` fold the records again; `summary.json` is never read.

## Testing a project's plugin

`testing.ts` exports `fakeSystem(script)` (an in-memory system with scripted replies, tool calls, signals and errors,
and a `log` of every call) and `fakeClock({ auto })` (time that moves only by `advance(ms)`, or by itself on each
`sleep`). `createEvalCommand(project, { io })` takes stdout, stdin, the exit code, the clock and an abort signal, so a
whole command runs in a test; `cli.test.ts` is the example.

Tests in GenesisTools: `bun scripts/test.ts src/utils/eval-engine src/eval`.

## Canonical ownership and strict JSON

GenesisTools owns this folder. It remains portable: runtime imports are limited to zod, commander, Node built-ins and local files. The import-boundary regression checks the complete folder, including tests. Client projects vendor the selected committed folder verbatim with one source provenance header per file and use three-way reconcile against that recorded commit for later updates.

This folder has an explicit, user-approved exception to GenesisTools' SafeJSON convention. Native JSON parsing is intentional for scenario input, canonical hashes and durable run records. Comments and trailing commas remain invalid. The Biome exception is scoped to `src/utils/eval-engine/**` and changes only the restriction on bare JSON. Every other lint rule remains active. Host integration lives outside this folder and uses normal GenesisTools utilities.

The GenesisTools host and its offline task-agent project are documented in `src/eval/README.md`. A selected project module is trusted executable code. Its own imports and transports remain the project's responsibility.

### Cleanup and offline planning limits

Conversation cleanup has a one-second deadline and ends promptly on cancellation. A cleanup failure or expiry is recorded in `closeError` without replacing the behavioral verdict. The engine cannot force a project-owned handle to close after that deadline.

An offline matrix `check` requires the matrix's explicit `variants` list. The default first variant belongs to the live system's `describe()` response, so the offline checker rejects an omitted list instead of publishing a placeholder plan hash. A normal `run` still selects the live system's first variant when the matrix omits it.

Final-record publication failures stop the invocation and propagate the storage error. They never replay the completed conversation. Reopen the run to determine which immutable records were published before resuming it.

Setup schemas must produce JSON and be idempotent when applied to their own output. The current loader parses
stored setup values again when loading scenarios and resolving plans. Non-idempotent or type-changing Zod
transforms are unsupported. Choose raw versus normalized setup storage before extending this contract; that
change must account for saved scenario hashes and resume compatibility.

Judge prompt version 2 records the tool-observability clarification. Judge expectations are excluded from
comparisons across the prompt-version boundary.
