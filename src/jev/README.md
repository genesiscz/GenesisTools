# Jev

Try `typesafe-ai/jev` through Vercel AI Gateway. Jev evaluates shared state and returns
boolean probabilities, named choices, and scores. It does not generate chat replies.
Requires Bun and AI SDK 7.0.105 or newer.

## Dashboard

```sh
tools jev dashboard
# Alias: tools jev ui
# Choose another local port: tools jev dashboard --port 3090
```

The dashboard uses the `tools artifact` Vite/React engine and opens in your browser.
Start it through `tools jev dashboard` so its local API is mounted along with the UI.
It binds to `127.0.0.1` and reuses the credential saved by `tools jev login`.
The browser never receives the API key. Ctrl+C stops the foreground server.

- **Playground:** ask boolean questions, select between named choices, or score an ordered scale.
- **Request editor:** edit JSON/JSONC and evaluate several questions in one request.
- **TypeScript lab:** choose a generation mode, give a goal, optional stdin, and a step limit.
  Step makes one decision. Run continues until Jev selects `<done>` or reaches the limit.
  Stop aborts the active request and preserves completed steps. Reset starts over.
  The source, legal next tokens, selected-token probabilities, model confidence, goal
  completion probability, and decision trace update after each response.

A completed program is type-checked with `tsgo` and run with Bun. The compiler and program
outputs, exit codes, and timeouts appear below the source. Download the `.ts` file or
experiment JSON to reuse outside the browser.

Two modes are available:

- **Constrained tokens:** supply a string vocabulary. The TypeScript grammar supports typed
  numeric `const`/`let`, reassignment to `let`, `+`, `-`, `*`, `console.log`, and numeric stdin
  through `Bun.stdin`. It excludes loops, imports, functions, arbitrary property access,
  file writes, and network operations.
- **Free characters (experimental):** no string vocabulary or grammar filtering. Jev chooses
  one printable ASCII character, tab, or newline per request, plus a finish choice. This still
  uses a finite alphabet because Jev is a classification model, not a text-generation model.
  It can spell new strings and source constructs, but may generate invalid TypeScript or
  finish early. A live test produced invalid syntax; this is not a reliable code generator.

`<done>` is a control choice and is never emitted into the source. Neither a valid grammar
nor Jev's completion probability proves that a program fulfills the goal.

Each selected token or character costs one Jev evaluation. Runs allow up to 2048 steps and
have a five-minute deadline. Type-checking has a 30-second deadline; execution has a three-second
deadline and bounded output. Child processes use a temporary working directory and a minimal
environment without gateway credentials. Character mode checks and runs inside the macOS
sandbox: network access, child processes, writes outside the run directory, and unrelated
home/temporary-file reads are blocked. Other operating systems reject character execution
until a sandbox implementation is available. Type-check failures prevent execution.

## TypeScript lab from the CLI

```sh
tools jev experiment example > experiment.json
# No vocabulary or grammar filtering:
tools jev experiment example --characters > characters.json
tools jev ts state experiment.json   # source and legal tokens, no model call
tools jev ts step experiment.json    # one model decision
tools jev ts run experiment.json     # JSONL progress, Ctrl+C to stop
# The dashboard exports a completed request with its tokens:
tools jev ts compile downloaded-experiment.json
```

`experiment` is the main command; `typescript` and `ts` are aliases.
`tools jev status` reads the configured gateway balance without generating anything.

## Layout

- `commands/`: thin CLI adapters for login, evaluation, experiments, and dashboard startup.
- `lib/`: request validation, gateway access, error reporting, grammar, token decisions,
  type-check/run, and the local HTTP adapter under `lib/server/`.
- `dashboard/`: artifact entry, browser client, and shared-theme styles.

Both the CLI and HTTP routes use the same library functions. The execution pipeline does not
depend on TypeScript:

- `ExperimentLanguage` defines source generation and metadata; `TypeScriptLanguage` is the
  first implementation, registered in `LanguageRegistry`.
- `GenerationMode` is implemented by `GrammarTokenMode` and `CharacterMode`.
- `LanguageCompiler.prepare()` returns a checker/runtime plan; `TypeScriptCompiler` uses
  tsgo and Bun, registered in `CompilerRegistry`.
- `compiler.ts` owns shared process execution, deadlines, cancellation, output limits, and
  sandbox application.

To add a language, implement and register its language and compiler classes. Character mode
can use the new language without grammar changes; constrained mode needs that language's
token-state implementation. The current dashboard intentionally exposes TypeScript only.

## Authenticate

```sh
tools jev login
```

The command opens Vercel's AI Gateway API keys page, then asks for the key in a masked
terminal prompt. The key is stored in `~/.genesis-tools/jev/config.json` with mode `0600`.
It is stored locally in plaintext, readable by your user account. It is never printed.
The Codex Vercel plugin connection and the CLI's AI Gateway credential are separate.

Alternatively, set `AI_GATEWAY_API_KEY` in the environment or pipe a key to
`tools jev login --stdin`. Do not put keys in command arguments or tracked files.
Credential precedence: `AI_GATEWAY_API_KEY`, saved key, then `VERCEL_OIDC_TOKEN`.
OIDC tokens expire; the command does not rotate them or log into Vercel automatically.

Vercel may require a credit card on the account before serving requests, including
requests covered by free credits. A `customer_verification_required` response is an
account-verification block; it does not mean the API key needs replacing. The CLI
prints Vercel's verification link for this case.
Jev is restricted to purchased AI Gateway credits. The free credit balance alone does
not grant access. If the gateway reports a free-tier restriction, use its top-up link.

## Try it

```sh
tools jev demo
tools jev ask 'Was a refund issued?' --state 'The support agent issued a full refund.'
printf '%s' 'Please refund my duplicate charge.' | tools jev ask 'Is a refund requested?'
```

Results are JSON on stdout, including answers, token usage, and provider metadata.
A boolean's `probability` estimates true. A score is indexed from zero across your
ordered criteria. Choice and score confidence may also appear in provider metadata.

## Custom decisions

```sh
tools jev demo --example > decisions.json
# Edit state, questions, criteria, and question IDs.
tools jev run decisions.json
cat decisions.json | tools jev run -
```

State and instructions accept text, JSON objects, or arrays. Choice criteria are a
nonempty map of option names to descriptions. Score criteria are an ordered array
of at least two levels. Boolean criteria may describe the true and false cases.
Descriptions may be structured JSON or null. JSONC comments are supported in input files.
Unknown request fields are rejected before authentication or network calls.

Requests use standard gateway retention by default. Add `--zdr` to require Zero Data
Retention; Vercel restricts this option to Pro and Enterprise plans. An explicit ZDR
request that fails is never retried without ZDR.

Requests have a 30-second deadline with no automatic retries. Set `--timeout 60000`
to allow one minute, up to five minutes.
`demo --example` and `--help` make no model requests and need no credentials.

In an unmerged worktree, run `bun run /absolute/path/to/worktree/src/jev/index.ts` instead
of the global `tools` executable, which may still point at the main checkout.

References: [Vercel evaluation docs](https://vercel.com/docs/ai-gateway/modalities/evaluation)
and [AI Gateway keys](https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys).
