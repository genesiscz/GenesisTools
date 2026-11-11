# tools jev

`tools jev` runs Jev, a classification model from TypeSafe (`typesafe-ai/jev` on Vercel AI Gateway). Jev reads
shared state and answers typed questions: a boolean probability, a named choice, or a score. It never writes chat
replies. This tool wraps that model in practical commands: a code search for behaviour (`grep`), a command router
(`route`), a transcript compactor (`compact`), claim and file screening (`verify`, `screen`), voice and goal-driven
control of macOS apps and browser pages (`listen`, `loop`, `watch`), and a local lab with a TypeScript generator, a
fly-brain arena and a control workbench (`dashboard`).

It needs Bun and AI SDK 7.0.105 or newer (`package.json` pins `ai` at `^7.0.105`). Every paid call costs $0.042 per
million input tokens; output is free.

## Quick start

```bash
tools jev login                     # save a key for the default provider (TypeSafe)
tools jev demo --example            # print a sample request; no model call, no key needed
tools jev ask "Was a refund issued?" --state "The agent issued a full refund."
tools jev grep "Where is a request retried after a timeout?" src
tools jev route "list tmux sessions"   # prints the GenesisTools command; --run executes it
tools jev dashboard                 # open the local lab on 127.0.0.1:3088
```

## Commands

Every paid command takes the root option `--provider typesafe|vercel`, before or after the subcommand
(`tools jev ask "…" --provider vercel`). When it is absent, the saved `provider` setting applies, then `typesafe`.

### Account, cost and settings

- `login [--stdin]`: open the provider's key page and save the key you paste in a masked prompt. `--stdin` reads a
  piped key and opens no browser.
- `status`: is a credential available, and (Vercel only) what is the gateway credit balance. Generates nothing.
- `spend [--from <date>] [--to <date>] [--days <n>] [--json]`: what Jev cost, by feature, by model and by day
  (`--days` rows in the day table, default 14).
- `config show [--json]`, `config set <key> <value>`, `config unset <key>`: saved defaults. See Configuration.

### Plain evaluation

- `demo [--example] [--timeout <ms>] [--zdr]`: evaluate a sample with all three question types. `--example` prints
  the request JSON with no model call.
- `ask <question> [--state <text>] [--timeout <ms>] [--zdr]`: one boolean question; the state comes from `--state`
  or stdin.
- `run <file|-> [--timeout <ms>] [--zdr]`: evaluate a JSON or JSONC request file.
- `look --image <path> --intent <text> [--blocks]`: OCR an image and let Jev pick the text region that matches the
  intent. Read-only. Exits 1 when nothing resolved.

### Search and agent helpers

- `grep [question] [root]`: find the source for a behaviour when you do not know the symbol or the file. Uploads
  eligible source to Jev. Flags: `--budget <calls>` (default 100), `--json`, `--no-cache`, `--cache-clear`,
  `--hidden`, `--no-ignore`, `--include-dependencies`, `--include-sensitive`, `--concurrency <n>` (default 32),
  `--max-source-bytes <n>` (default 0, unlimited).
- `route [utterance]`: pick one GenesisTools command for a plain request and bind its arguments. Flags: `--run`,
  `--yes` (confirm a destructive `--run`), `--plan`, `--allow-destructive`, `--suggest`, `--zsh`, `--refresh`,
  `--src [dir]`.
- `compact [file|-]`: keep, truncate or drop tool results in a transcript; never rewrites user or assistant text.
  Flags: `--keep <n>` (0.5), `--pin <n>` (6), `--max-result <n>` (800), `--threshold <n>` (0.25),
  `--keep-tokens <n>`, `--source auto|jsonl|claude|codex|grok`, `--follow`, `--llm`, `--summaries`, `--table`.
- `verify`: judge claims against a document or a directory. Flags: `--claims <file|->`, `--against <file|->`,
  `--against-dir <dir>`, `--max-files <n>` (30), `--purpose <ids>`, `--task <text>`, `--custom <file>`,
  `--only-changed`, `--list`, `--sarif`, `--gate`, `--json` (keep the raw Jev payload in the result).
- `screen [path|-]`: score files, a directory or a diff for a purpose class; never writes review comments. Flags:
  `--purpose <ids>` (required, there is no default), `--list`, `--max-files <n>` (30), `--only-changed`,
  `--custom <file>`, `--task <text>`, `--sarif`, `--gate`, `--json` (keep the raw Jev payload in the result).
- `mcp`: start the read-only Jev MCP server on stdio.

### Live control of apps and pages

- `listen`: live speech into a Jev choice over the observed actions of one app, then a native press, a menu click or a
  browser action. The full flag list is in the listen section below.
- `wake status|enable|disable|test`: the wake-phrase marker. `listen` takes only its languages. Never opens a
  microphone.
- `loop --goal <text>`: a goal-driven see and act loop on a native app (`--app`), a CDP page (`--browser`,
  `--surface browser`) or both merged (`--surface auto`). `--max-steps <n>` (default 8).
- `watch --app <name> --goal <text>`: a bounded high-frequency policy on one window. `--hz <n>` (1 to 10, default 4),
  `--max-seconds <n>` (15), `--max-requests <n>` (20), `--ocr`.
- `replay <runDir> [--step <n>] [--json]`: rebuild a recorded `loop` run's decisions with today's code and the saved
  answers. No Jev call.
- `sessions [ref]` (alias `logs`): recent `listen`, `loop` and `watch` runs read back from the day logs.
- `control <command>`: every `tools control` command, run from this Jev checkout (see Control below).

### Labs

- `dashboard [--port <port>] [--no-open]` (alias `ui`): the local web lab. Port 3088 by default; it moves up when the
  port is busy.
- `experiment example|state|step|run|compile` (aliases `typescript`, `ts`): build a TypeScript program one Jev
  decision at a time.
- `arena circuits|load|decide|simulate`: the fly arena's MaleCNS circuits and Jev policy, headless.
- `evaluation create|list|show|rm|run` (aliases `probably`, `prob`): the Probably Lang lab.
- `demo reel` and `control demo [chapter]`: fixture demos of the live-control features. They spend nothing.

## Evaluation requests: `ask`, `run`, `demo`

```bash
tools jev demo
tools jev ask 'Was a refund issued?' --state 'The support agent issued a full refund.'
printf '%s' 'Please refund my duplicate charge.' | tools jev ask 'Is a refund requested?'

tools jev demo --example > decisions.json   # edit state, questions, criteria and question ids
tools jev run decisions.json
cat decisions.json | tools jev run -
```

Results are JSON on stdout: the answers, token usage and provider metadata. A boolean's `probability` estimates
true. A score is indexed from zero across your ordered criteria. Choice and score confidence may also appear in the
provider metadata.

The request format:

- State and instructions accept text, JSON objects or arrays.
- Choice criteria are a nonempty map of option names to descriptions.
- Score criteria are an ordered array of at least two levels.
- Boolean criteria may describe the true case and the false case.
- Descriptions may be structured JSON or null. Input files may carry JSONC comments.
- Unknown request fields are rejected before authentication or any network call.

Requests have a 30 second deadline and no automatic retries. `--timeout <ms>` takes 1 to 300000 (five minutes).
Requests use standard gateway retention. `--zdr` requires Zero Data Retention; Vercel offers it on Pro and
Enterprise plans only. A ZDR request that fails is never retried without ZDR, and the TypeSafe provider rejects
`--zdr` instead of silently weakening it.

`demo --example` and `--help` make no model request and need no credential.

References: [Vercel evaluation docs](https://vercel.com/docs/ai-gateway/modalities/evaluation) and
[AI Gateway keys](https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys).

## Providers

Two providers serve the same model. The default is **typesafe**.

- **typesafe**: the direct TypeSafe API through the official AI SDK provider `@ai-sdk/typesafe-ai`, on the
  `jev-latest` alias. Key: `TYPESAFE_API_KEY` or the saved key. `status` checks only that a credential is
  available; it does not validate the key or report a balance.
- **vercel**: Vercel AI Gateway's `typesafe-ai/jev`. Key: `AI_GATEWAY_API_KEY`, the saved key, or
  `VERCEL_OIDC_TOKEN`.

The gateway answers `Service temporarily unavailable` often enough to lose whole utterances of a live `listen`
session (seven in one 39 second run on 2026-09-19). That is why it is no longer the default.

Both providers return the same boolean, choice and score results, support cancellation, and make zero automatic
retries. Native TypeSafe `noul` probabilities are normalized to boolean probabilities. Confidence is kept separate
from the probability distribution. Neither provider downloads model weights. The dashboard's provider selector
applies to the playground, the request editor, the TypeScript lab, the fly arena and the Control lab.

```bash
tools jev login --provider typesafe
tools jev demo --provider typesafe
tools jev ask "Was a refund issued?" \
  --state "The agent issued a full refund." \
  --provider vercel
```

The provider classes, the request schema and credential access live in `src/utils/ai/evaluation/`.

## Grep: find the source for a behaviour

`tools jev grep` is a port of [jevgrep](https://github.com/dzhng/jevgrep) (the `jg` CLI). An agent asks what code
does without knowing the symbol. The command walks the tree, asks Jev which directories, files and declarations
matter, and prints verbatim source. It does not explain, edit or test anything. For a known symbol or string, use
`rg`. Do not install `jg`; this command replaces it.

```bash
tools jev grep "Where is authentication checked before a request reaches a handler?"
tools jev grep "How are database connections created, pooled, and closed?" src
tools jev grep "Which tests cover retry behavior when a request times out?" . --json
tools jev grep --cache-clear
```

- **Budget.** A search plans for about 100 Jev calls (`--budget <calls>`). It walks the best-scoring directories
  first, scores files by a small card (opening lines and a declaration index), checks only the shortlisted files with
  upstream's full-source question, and selects source for the highest-priority files whose complete selection still
  fits. Admitted files beyond that stay in the list as locations-only leads, and `Warning:` lines say what the budget
  left out. `--budget 0` runs upstream's exhaustive loop, which reads every file in every explored directory; on this
  repository that was over 1,200 calls for one question. Try a narrower root or a larger budget first.
- **Upload.** Eligible source under the root goes to the configured provider: `typesafe` pinned to `jev-1.13.0` (the
  cache keys on the model id, so a moving alias would serve stale answers), or the gateway's `typesafe-ai/jev` with
  `--provider vercel`.
- **Excluded by default:** dot paths, `.gitignore` and `.ignore` matches, dependency and build directories,
  credential file names (`.env`, `*.pem`, `id_rsa`, `secrets.json` and similar), symlinks, binaries, and the jev
  config and grep cache. `--hidden`, `--no-ignore`, `--include-dependencies` and `--include-sensitive` each widen one
  category. The name list is not a secret scanner; do not rely on it as a guarantee.
- **Output.** Stdout is the packet: the file list, source blocks, declaration locations, then `End context.`. A packet
  without that last line was cut. Errors go to stderr. `--json` prints the retrieval object instead.
- **Context.** The packet also names agent instruction files (`AGENTS.md`, `CLAUDE.md` and similar), the project that
  owns the returned files, and a test command per shown test case that was never executed. These come from the shared
  gatherers in `src/utils/repo-context/`.
- **Cost.** At a terminal the command prints what the run spent on stderr; `--json` carries it in
  `counts.inputTokens` and `counts.costUsd`. `bun src/jev/lib/grep/evaluations/jevgrep/run.ts` compares this port
  with upstream `jg` on the same budget ([its README](lib/grep/evaluations/jevgrep/README.md)).
- **Cache.** Answers (never source) are cached for seven days in `~/.genesis-tools/jev/grep-cache/`, keyed by
  provider, model, question, relative path and content hash. `--no-cache` skips it for one run. `--cache-clear`
  deletes only that directory, never the arena cache in `~/.genesis-tools/jev/cache/`.
- **Python** has no parser here: `.py` and `.pyi` files are read as text chunks, so leads are coarser than upstream's
  CPython-backed declarations. Upstream reports lower agent cost on a Python SWE-bench run; that figure is upstream's
  measurement and is not a claim about this port.

The same search is the MCP tool `jev_grep` and `POST /api/jev/grep` on the dashboard server. The contract is
[docs/specs/2026-09-28-jev-grep.md](../../docs/specs/2026-09-28-jev-grep.md); the license notice is
[lib/grep/NOTICE.md](lib/grep/NOTICE.md). The plugin skill `gt:jev-grep` teaches an agent to read the packet.

## Route, compact, verify, screen

These verbs keep Jev a decision workbench: it picks a command, a tool result to keep, or a verdict per claim.

```bash
tools jev route "show unresolved review threads on owner/repo#42"
tools jev route "list tmux sessions" --run
tools jev route "build the app then run the tests" --plan
tools jev compact session.jsonl --table
tools jev verify --claims claims.json --against notes.md --purpose pii-names,secrets --gate
tools jev screen src/jev/lib --purpose secrets --max-files 20
```

### route

`route` picks a GenesisTools command from a catalogue built by introspecting the tools source, and binds argv from
spans of the utterance. It prints the command by default. `--run` executes it, and a destructive route also needs
`--yes`. `--plan` splits the utterance on "then" and "and then" into up to five routed steps and stops at a
destructive step unless `--allow-destructive`. `--suggest` prints the ten best catalogue rows. `--zsh` prints a zsh
widget and never writes `~/.zshrc`. The catalogue is cached in `~/.genesis-tools/jev/route-catalogue.json`;
`--refresh` rebuilds it.

### compact

`compact` shrinks a transcript by touching tool results only. User and assistant text is copied verbatim. Each tool
call is kept, truncated to `--max-result` head characters, or dropped; a drop always takes the paired `tool_result`
with it, so the output never carries an orphan result.

Four input shapes are accepted. Detection is automatic and `--source` forces one:

| Shape | Looks like | `--source` |
|---|---|---|
| generic JSONL | `{role, content, toolCalls:[{id,name,input,result}]}` | `jsonl` |
| block JSONL | one Anthropic-style message per line | `jsonl` |
| JSON array | one array of messages in either shape | `jsonl` |
| native | a Claude, Codex or Grok transcript | `claude`, `codex`, `grok` |

A native source is read through the shared agent-sessions readers and needs a file path, not stdin. Output is always
generic JSONL, so a compacted transcript parses back and can be compacted again.

Pins protect a message from a drop. The last `--pin` messages are pinned; so are the last user turn, the last failing
tool call, and any message carrying a `#pin` marker, and those three keep their result verbatim rather than
truncated. Below `--threshold` reduction the input is returned unchanged.

`--llm` asks Jev, in one request per 20 calls, whether each call must stay and whether its full result must stay. An
answer at or above 0.8 replaces the heuristic verdict in the output, not only in the report. `--summaries` then
summarizes the results Jev marked summarizable and keeps a summary only after Jev judges it faithful; a rejected
summary leaves the truncated head in place. `--follow` stays attached to the file and decides again each time it
grows. `--table` prints the decision table on stderr; stdout is always the JSON result.

```bash
tools jev compact ~/.claude/projects/<project>/<id>.jsonl --source claude
tools jev compact session.jsonl --llm --summaries --max-result 200
tools jev compact live.jsonl --follow
```

### verify and screen

`verify` judges each claim as `supported`, `contradicted` or `sensitive` against a document (`--against`) or each
file of a directory (`--against-dir`). Claims are a JSON array of `{id, text}`, a bullet list, or stdin. Both verbs
also score purpose templates; `--list` prints them with their questions. The built-in ids are `pii-names`,
`pii-contact`, `secrets`, `prompt-injection`, `relevance` (with `--task`), `risk`, `accuracy`, `contradiction`,
`license`, `focus-safety`, `pr-review`, `control-refusal`, `compact-safe`, `public-api-break`, `macos-tcc` and
`test-accounts`. `verify` uses `secrets,prompt-injection` when no `--purpose` is given. `screen` has no default and
fails without `--purpose`. `--custom <file>` adds a JSON array of your own templates. `--only-changed` keeps only
paths `git diff --name-only` reports. `--sarif` writes SARIF 2.1.0. `--gate` exits 2 when a gate rule fires. Both
verbs always print their result as JSON; `--json` only keeps the raw Jev evaluation payload in it.

## listen: voice control of one app

`listen` turns live speech into a Jev choice over the observed actions of one app, then dispatches a native press, a
menu click, or a browser action through `tools chrome-devtools`.

```bash
tools jev listen --stt deepgram --pcm-in mic --app Calculator --wake-mode contains
tools jev listen --stt fixture --transcript session.jsonl --app Calculator --dry-run
tools jev listen --continuous
```

### Which app it controls

`listen` needs no target flags. Without `--app` the target **follows the focused window**: before every utterance it
asks the WindowServer which application is frontmost, and that app is the one the utterance controls. Speaking to the
app you are looking at needs no flag and no restart, and switching apps mid-session just works. The change is
announced as `target <app> (focus)` and logged as `listen target followed focus`.

Only when the focused application is the terminal's own process chain does it fall back to window z-order and take
the first on-screen window that is not the terminal or system UI. That fallback is a guess, and a window raised on
another display can sit above the app you mean. That is how a session started from a terminal targeted ChatGPT while
the intended app was Brave. Focus the app you want before the first utterance, or pass `--app`, and the guess never
applies. `--app` pins the target and turns focus following off.

Every utterance also offers a "switch to <app>" choice for each app with a window on screen (not the terminal and
not the system UI). Saying "switch to Calculator" brings that app to the front, and without `--app` the next
utterance controls it.

### Scope, menus and depth

The scope is `auto` by default, which observes the **whole window**. `window` is a strict superset of `chrome`:
measured on a live Brave window, every candidate `chrome` offers also appears under `window` (56 against 113 distinct
press candidates, 0 present only in `chrome`), so there is no reason to see less by default. `chrome` omits every
descendant of the page's `AXWebArea`, which is why a session on a browser used to abstain on anything inside the
page. `--scope chrome` brings the cheap tab-strip-only view back.

When a window is too large to observe at all (ax-tool refuses past 4000 elements, the observation schema past 2000,
because a truncated tree would hide real targets), the driver narrows to `chrome` once and says so in the log rather
than failing. That is the only smaller complete surface there is.

The app's menu bar items are offered as targets unless `--no-menus` is passed, and the menu session is rebuilt for
each new app.

`--depth` is rarely needed. ax-tool refuses a snapshot deeper than the requested depth rather than truncating it, and
its default of 20 is too shallow for an Electron app or a heavy web view. The driver reads the refused depth back out
of that error and retries deeper by itself (20, then 40, then the ax-tool ceiling of 50), so a deep app costs one
extra `see` and no longer ends the session. Pass `--depth` only to start at a known depth and skip that first
refusal.

### Staying armed

A `--continuous` session stays armed after a dispatch until you say stop or cancel, and it survives one failed
utterance. Anything that throws while deciding (an unreadable window, an `--expected-url` mismatch, a native timeout)
prints one `skipped` line, logs a warning, and leaves the session armed for the next thing you say. Without
`--continuous` a failure ends the run and exits 1.

### Browsers: the page comes from the DevTools Protocol

```bash
tools jev listen --surface browser --page-url example.com
tools jev listen --surface browser --page-index 4 --inputs '{"email":"alice@example.com"}'
```

A real web page cannot be reached through the accessibility tree. Measured on live Brave windows: one exceeded
ax-tool's hard `--depth 50` ceiling, another exceeded the element limit, and both fell back to `chrome` scope, whose
candidates are `Reload`, `Bookmark this tab`, the address bar and the extension buttons. No page content on either
site.

A browser target takes the CDP surface by itself. The target is a browser when its app is on the control list
(Brave Browser, Google Chrome, Chromium, Microsoft Edge, Arc, Vivaldi, Opera, Safari, Firefox, Zen). When
`--surface` is not passed, `listen` then prints `target is a browser; reading the page over CDP on port <n>` and
reads the page over CDP. It picks the page whose title contains the window title's first part (the text before
` - `), unless `--page-url`, `--page-index` or `--url` selects one. So the browser needs a DevTools port. Pass
`--surface ax` to keep the accessibility tree instead. Safari and Firefox do not serve the Chrome DevTools Protocol,
so they need `--surface ax`.

`--surface browser` reads the page over CDP in the same way, through the same snapshot the goal loop uses. On one
busy live site that was 558 nodes and 299 clickable rows, each with a role, an accessible name and a uid, including
every link with its URL. The rows Jev may choose become the page's own controls, plus `back`, `reload`, `scroll_up`,
`scroll_down` and `wait`, so scrolling to something below the fold is a thing Jev can decide to do. It never could on
the AX surface.

`--page-url <text>` or `--page-index <n>` selects the page; `--url <url>` opens a new page first. With none of them
and more than one page open, the surface refuses rather than act on whichever tab the server had selected. `--inputs`
is the only text that may ever be typed; a field with no matching key is not offered at all. `--port <n>` is the CDP
port (default 9222). The saved `browser.port` setting does not reach `listen` or `loop` yet, because the flag's own
default of 9222 always wins, so pass `--port` for any other port.

### Too many candidates: the tournament

Jev's choice question accepts at most 255 options, and a real web page offers far more: one live Brave window produced
514 (390 press rows, 120 menu items, the chrome verbs). That used to fail outright with
`TypeSafe Choice questions support at most 255 options`.

Nothing is ranked away, because ranking would decide the answer instead of letting Jev decide it. The candidates are
split into the fewest balanced groups that fit, Jev answers each group in parallel, and the winners meet in a final
round. Every round offers `abstain`, so a group with no match contributes no finalist and a lone finalist still has to
beat abstaining. The admission gate judges the final round only, at the usual thresholds. The play-off recurses, so
any count terminates; a 2000-row observation settles in two rounds.

The live run above cost 4 questions: 3 groups of 171, then the final. `tools jev sessions` shows the round count, and
the day log carries `candidate tournament round` and `tournament finalists`.

### Speech (STT) and the wake phrase

`--pcm-in` picks the audio: `mic` (the default) is the GenesisTools.app microphone face, so the macOS microphone prompt
and grant belong to GenesisTools, not to the terminal. `-` is stdin, a path is a raw s16le mono 16 kHz file, and
`ffmpeg[:device]` uses avfoundation. `--transcript <file>` replays a JSONL transcript instead of audio.

`--stt` picks the provider: `deepgram`, `openai` (realtime transcription, audio resampled to 24 kHz),
`xai` (Grok streaming STT), `elevenlabs` (Scribe realtime) or `fixture` (a JSONL transcript). The older spellings
`grok-live`, `grok`, `gpt-realtime`, `gpt`, `scribe` and `mock` still work. Without `--stt`, `--transcript` makes
the provider `fixture`. At a terminal the default is the saved `stt` setting, else `deepgram`. From a pipe there is
no default: `listen` fails with `Unknown STT provider ''`, so an agent passes `--stt`. Each provider needs a
`tools ai` account:

```bash
tools ai config account add --provider deepgram --name deepgram --use-env DEEPGRAM_API_KEY
```

`--account` picks one; otherwise the provider's first enabled account is used. The shared session code lives in
`src/utils/ai/stt/`.

`--language` takes ISO 639-1 codes in priority order (`cs,en`). On the fixture measured 2026-09-18, Czech transcribed
best through ElevenLabs. Deepgram pins `language=cs` whenever Czech is requested, because its `multi` code-switching
mode does not cover Czech (`src/utils/ai/stt/providers/deepgram.ts`).

The wake gate is off by default (`--wake-mode off`). `contains` is a deterministic matcher; `jev` lets Jev confirm the
wake and adds a destructive gate. `--wake <phrases>` defaults to `hey jev,hey jeff,hey genesis,ok genesis`. Every
tested provider hears "hey jev" as "hey jeff", so both are wake phrases.

`tools jev wake enable` saves the phrases, mode, STT provider, account and languages in
`~/.genesis-tools/jev/wake.json`. Its defaults are `--word "hey jev,hey jeff"`, `--mode contains` and
`--stt fixture`. `listen` takes only the languages from that marker (when `--language` is not passed). It never
reads the marker's STT provider or account, and it cannot reach the marker's phrases or mode, because `--wake` and
`--wake-mode` have their own defaults (the four phrases above, and `off`). So pass `--wake-mode`, `--stt` and, for
other phrases, `--wake` every time.
`wake enable` and `wake status` print a `listen` command with the saved mode, STT provider, account and languages;
it leaves out the phrases.

```bash
tools jev wake enable --word "hey jev,hey jeff" --mode contains --stt deepgram
tools jev wake status
tools jev wake test                # the matcher over sample utterances; no microphone
tools jev wake disable
tools jev listen \
  --wake-mode contains \
  --wake "hey jev,hey jeff" \
  --stt deepgram \
  --app Calculator
```

`wake enable` needs a TTY the first time; `--yes` allows a non-TTY enable when a marker already exists. With
`GENESIS_TOOLS_NO_WAKE=1`, `wake enable` refuses and `wake status` shows `blocked: true`.

The floating voice capsule (`--capsule on|off`, on by default with a mic in a TTY) is a small overlay drawn by
GenesisTools.app. It shows the live transcript, a waveform built from the microphone level, and the label of the
action Jev chose. It is decoration: nothing in `listen` waits on it, and it never gates a decision.

### All listen flags

- Target: `--app <name|pid>`, `--window-id <id>`, `--window-index <n>` (default 0, the frontmost window),
  `--scope auto|window|chrome`, `--no-menus`, `--depth <n>`, `--expected-url <url>` (pin the browser document by its
  AXURL; a mismatch blocks the session).
- Browser surface: `--surface ax|browser|auto` (chrome verbs need `--port`), `--port <n>`, `--page-url <text>`,
  `--page-index <n>`, `--url <url>`, `--inputs <json>`.
- Audio: `--pcm-in <input>`, `--stt <provider>`, `--account <id>`, `--language <codes>`, `--transcript <file>`.
- Wake: `--wake <phrases>`, `--wake-mode off|contains|jev`, `--from-wake` (transcript replay keeps events at or after
  the last wake phrase).
- Decisions: `--goal <text>` (a standing goal; otherwise the transcript is the intent), `--gate <n>` (admission
  probability, default 0.8), `--max-seconds <n>` (default 60), `--prepare` (verify the semantic target natively
  before each dispatch; web fields use paste and keys), `--dispatch-ahead` (dispatch a prefetch hit without a second
  `see`).
- Safety and output: `--continuous`, `--capsule on|off`, `--dry-run` (never dispatch), `--force-act` (allow dispatch
  from a pipe), `--yes` (allow a destructive wake command without a spoken confirmation), `--json` (full result with
  snapshot tokens).

## loop, watch, replay: goal-driven control

```bash
tools jev loop --app Calculator --goal "press the number 7"
tools jev loop --browser --page-url 127.0.0.1:3990 --goal "open the settings page"
tools jev loop \
  --surface auto \
  --app Calculator \
  --page-url 127.0.0.1:3990 \
  --goal "press the number 7"
tools jev watch --app Calculator --goal "the display shows 77" --hz 4 --max-seconds 10 --ocr
tools jev replay ~/.genesis-tools/jev/runs/<run-folder>
```

Every live verb shares three rules:

- `ok: true` means dispatched, never "the goal happened".
- An act needs fresh observed evidence.
- The admission thresholds are fixed: `minProbability` 0.8, `minMargin` 0.15, `minConfidence` 0.7.

The one exception is the goal-loop fan-out: an act whose risk score is below 0.5 (reversible) passes at 0.6 with a
0.25 margin, and an act admitted more confidently than `done` is taken before the loop stops. The runs that showed
both are in [docs/benchmarks-jev-browser.md](../../docs/benchmarks-jev-browser.md).

### loop

`loop` decides every step with Jev. `--surface ax|browser|auto` picks the surface: `auto` puts AX rows and CDP page
rows in one state. The browser surface acts on one CDP page (`--page-url` or `--page-index`, or `--url` to open a new
one), read with one in-page script per step through `DomPage` (`src/chrome-devtools/lib/dom/`, no
chrome-devtools-mcp). Rows are page-scoped node ids, never selectors, and each act checks its target again and
hit-tests it first. `--prepare`, `--expected-url` and `--depth` work on the AX surface as they do for `listen`.
`--yes` allows high-risk acts.

The loop stops as `stalled` after three acts that left the screen unchanged, and as `repeating` when it picks an act
already taken on the same screen a second time in a row. Labels already tried on a screen reach Jev as
`already_tried_on_this_screen`. A wait counts toward neither. Each step prints its time (`see · jev · act`), and the
run ends with Jev's calls, seconds and tokens.

`--inputs <json>` holds the only values the loop may type. `--writer [model]` lets a small model write the text for a
field that `--inputs` does not cover (a search query the goal names). Jev still picks the row. Secret, email, phone
and credential-like fields are never offered, an answer that mentions a credential is refused, and an identical
request is asked once.

Every run writes `~/.genesis-tools/jev/runs/<stamp>-<pid>-<goal>/`: one `step-NNN.json` per step (the inputs, the
exact Jev requests, every answer, the decision and the timing) plus `run.json`. The newest 30 runs are kept.
`--no-record` skips the folder.

### replay

`replay <runDir>` rebuilds each recorded step's decision with today's code and the saved answers, with no Jev call.
`same` means the request and the decision are unchanged; `CHANGED` names the step whose prompt or gate changed since
the run. `--step <n>` replays one step.

### watch

`watch` runs a bounded high-frequency policy on one window: a delta `see` per tick and one fan-out per tick. It stops
at the goal, at `--max-seconds` or at `--max-requests` paid evaluations. `--ocr` adds native OCR text regions of the
window to each tick's state. `--expected-url` and `--depth` work as for `listen`.

### The browser benchmark

`bun src/jev/scripts/browser-benchmark.ts [--runs N] [--task search|checkout|settings] [--out file.json]` runs a
headless Chrome on a throwaway profile against fixture pages on 127.0.0.1. Success is checked in code, never by Jev's
own "done". It spends real Jev requests (a few per task). Results and dated baselines are in
[docs/benchmarks-jev-browser.md](../../docs/benchmarks-jev-browser.md).

## sessions: reading a past run back

```bash
tools jev sessions              # recent listen, loop and watch runs, newest first
tools jev sessions last         # the newest run in full
tools jev sessions 2            # the second row of the list
tools jev sessions 9716         # by pid
tools jev sessions last --json  # the same, machine-readable
```

The list gives one row per run with the app, the STT provider, what you said and how it ended (`3 act`,
`18 abstain`, `1 error`, `nothing said`). Opening one prints its timeline: every `see` with its element count, the
menu items offered, each admission verdict with probability, margin and confidence, each decision with the transcript
that produced it, and every error. That is enough to answer "why did it not press 7" without opening a log file.
`--day <YYYY-MM-DD>` reads one day, `--days <n>` widens the scan (default 3), `--limit <n>` sets the rows (default
20).

A day log holds every tool's output and runs to tens of megabytes, so the scan parses only the lines that can belong
to a Jev session. Reading a whole day takes about two seconds. Days before yesterday are stored as `.zst`, and
reading one is not slower: on a 1.08 GB day, `sessions --day` took 1742 ms on the plain file and 1307 ms on the
compressed one (medians of 7), because the reader decodes 4 MiB frames.

## Control

`tools jev control <command>` is the full `tools control` command set (`see`, `act`, `observe`, `assist`, `fill`,
`resolve`, `judge`, `choose`, `await`, `replay`, `visual`, `ocr`, `sim`, `capture`, `doctor` and the rest), run from
this checkout. It is useful while this module is linked from a feature worktree and the main checkout's
`tools control` is older. It shares the root `--provider` option and the saved settings in `tools jev config`.

```bash
tools jev control replay context --chooser jev --provider typesafe
tools jev control resolve --app Editor --intent "Show line numbers" --provider typesafe
tools jev control fill --app Editor --data fields.json --provider typesafe
tools jev control assist \
  --app Editor \
  --goal "Enable line numbers" \
  --max-steps 3 \
  --provider typesafe
```

- `control observe`: one `see`, five questions in one request (target, done, blocked, wait, risk); the act is the
  target's own action.
- `control assist`: runs the fan-out by default with the double-toggle, recovery and no-change guards; `--no-fanout`
  restores the serial chooser.
- `control mcp` and `control computer-run` are aliases of `tools computer-use mcp` and `tools computer-use run`: the
  native computer API without Codex Computer Use or Sky. `control computer-run --file task.ts` runs a script file;
  `control mcp --repl` exposes a persistent JS and TS session with the computer API preloaded.

Use `--window-id` when more than one window is present. Limits and verification contracts:
[../control/README.md](../control/README.md) and [../computer-use/README.md](../computer-use/README.md).

### Fixture demos

`tools jev control demo [chapter]` runs one chapter (`listen`, `voice`, `watch`, `route`, `compact`, `observe`,
`verify` or `loop`, default `route`), and `tools jev demo reel` or `tools jev control demo reel` runs all of them.
Every chapter runs its real library function against a fixture evaluator, so no chapter spends money. The reel is
green only when every chapter's own readback confirmed. `--dir <dir>` writes one JSON artifact per chapter, `--record`
records the run with `tools control capture` when macOS allows it, and `--json` keeps the full evaluation payloads.
`--app Mail` is refused without `--i-mean-it`; use the AppKit fixture.

Note that plain `tools jev demo` (without `reel`) is a paid evaluation of the sample request.

## Dashboard

```bash
tools jev dashboard                # alias: tools jev ui
tools jev dashboard --port 3090    # another local port
tools jev dashboard --no-open      # start without opening a browser
```

The dashboard uses the `tools artifact` Vite and React engine and opens in your browser. Start it through
`tools jev dashboard` so its local API (`/api/jev/...`) is mounted with the UI. It binds to `127.0.0.1` and reuses the
credential saved by `tools jev login`; the browser never receives the API key. Ctrl+C stops the foreground server.

Its tabs:

- **Playground:** ask boolean questions, select between named choices, or score an ordered scale.
- **Request editor:** edit JSON or JSONC and evaluate several questions in one request.
- **TypeScript lab:** build a program one Jev decision at a time (below).
- **Fly arena:** the MaleCNS game (below).
- **Control:** the Control lab, with the areas Targets, Waits, Recovery, Workflows, Choosers, Visual OCR and Live
  policy.

### TypeScript lab

Choose a generation mode, give a goal, optional stdin, and a step limit. Step makes one decision. Run continues until
Jev selects `<done>` or reaches the limit. Stop aborts the active request and keeps completed steps. Reset starts
over. The source, the legal next tokens, the selected-token probabilities, the model confidence, the goal completion
probability and the decision trace update after each response.

A completed program is type-checked with `tsgo` and run with Bun. The compiler and program outputs, exit codes and
timeouts appear below the source. Download the `.ts` file or the experiment JSON to reuse it outside the browser.

Two modes:

- **Constrained tokens:** supply a string vocabulary. The TypeScript grammar supports typed numeric `const` and
  `let`, reassignment to `let`, `+`, `-`, `*`, `console.log`, and numeric stdin through `Bun.stdin`. It excludes
  loops, imports, functions, arbitrary property access, file writes and network operations.
- **Free characters (experimental):** no string vocabulary or grammar filter. Jev chooses one printable ASCII
  character, tab or newline per request, plus a finish choice. This still uses a finite alphabet because Jev is a
  classification model, not a text-generation model. It can spell new strings and source constructs, but may generate
  invalid TypeScript or finish early. A live test produced invalid syntax; this is not a reliable code generator.

`<done>` is a control choice and is never emitted into the source. Neither a valid grammar nor Jev's completion
probability proves that a program fulfills the goal.

Each selected token or character costs one Jev evaluation. A request allows up to 2048 steps (`maxSteps`, default 80)
and has a five-minute deadline. Type-checking has a 30 second deadline; execution has a three-second deadline and
bounded output. Child processes use a temporary working directory and a minimal environment without gateway
credentials. Character mode checks and runs inside the macOS sandbox: network access, child processes, writes outside
the run directory, and unrelated home and temporary-file reads are blocked. Other operating systems reject character
execution until a sandbox implementation exists. A type-check failure prevents execution.

The same lab from the CLI:

```bash
tools jev experiment example > experiment.json
tools jev experiment example --characters > characters.json   # no vocabulary or grammar filter
tools jev ts state experiment.json     # source and legal tokens, no model call
tools jev ts step experiment.json      # one model decision
tools jev ts run experiment.json       # JSONL progress, Ctrl+C to stop
tools jev ts compile downloaded-experiment.json   # replay, compile and run a dashboard export
```

### Fly arena: MaleCNS and Jev

Open the **Fly arena** tab, collect 12 sugar drops in 60 seconds, and dodge the swatter. Play with WASD or the arrow
keys and Space to dash, or use the on-screen controls. Pause stops the simulation and aborts pending Jev requests;
leaving the tab or hiding the page pauses play.

Four controllers share the same seeded game engine:

| Mode | Controller | Downloads / paid calls |
| --- | --- | --- |
| You | keyboard or touch | neither |
| MaleCNS reflex | food seeking plus simulated LC16 to MDN escape | circuit on first use |
| Jev policy | Jev picks forage, turn, dash or wait | Jev calls only |
| Jev + MaleCNS | Jev gets neural rates; local escape may override | both |

Jev runs at a configurable 1 to 10 second decision interval, with one request in flight and at most 30 calls per
round. Low-probability, failed or stale decisions fall back to the local controller. Responses older than four
simulated seconds are discarded. The game does not wait for network inference. The CLI's headless simulation awaits
each decision before advancing simulated time, so its Jev trajectories are not wall-clock browser replays.

The wiring selector keeps the original graph, permutes connection targets with the seed, or removes synaptic
influence. The latter two are controls, not extra biological models. Finished rounds record score, survival, mode,
wiring and seed for comparison; export includes decision traces and the circuit manifest. A single game result does
not establish a benefit from biological wiring.

Opening the dashboard, listing circuits, and playing Human or Jev-only modes never download a connectome. Selecting a
MaleCNS mode alone does not download it either: **Start** or **Step** loads the selected graph. Repeated starts reuse
the verified local cache.

| Subset | Neurons | Directed connections | Download |
| --- | ---: | ---: | ---: |
| Compact | 1,088 | 71,681 | 1.2 MB |
| Balanced | 1,788 | 215,329 | 3.5 MB |
| Standard | 2,888 | 470,170 | 7.7 MB |
| Expanded | 6,000 | 1,275,994 | 21.2 MB |

Files live under `~/.genesis-tools/jev/cache/male-cns/<pinned-revision>/`. The loader verifies the pinned Git blob
hash, byte size and graph counts before it publishes a cache file atomically. Concurrent loads share one download.
Invalid cache entries are replaced only when a load is requested. Files are not checked into the repo, and the 1.1 GB
raw connection table is not needed by this arena.

These are real **MaleCNS v1.0 circuit subsets**, not the full CNS. All retained cells and edges are simulated in a Web
Worker; the activity view samples up to 240 soma positions. Input currents, LIF dynamics, transmitter signs, motor
readout, food seeking and flight are explicit modelling choices. No learning, whole-fly emulation or biological
performance claim is made. See [data attribution and adaptations](lib/arena/NOTICE.md).

The arena from the CLI:

```bash
tools jev arena circuits                          # read-only; no download
tools jev arena load compact                      # first download, then cache hits
tools jev arena load compact --full               # also print the circuit
tools jev arena simulate --mode malecns --seconds 10 --seed 42
tools jev arena simulate --mode malecns --wiring shuffled --seconds 10
tools jev arena simulate --mode malecns --wiring disconnected --seconds 10
tools jev arena simulate --mode hybrid --seconds 10   # paid Jev decisions
tools jev arena decide observation.json           # one decision
```

`simulate` flags: `--mode human|malecns|jev|hybrid` (default `malecns`; human mode supplies no movement),
`--circuit compact|balanced|standard|expanded` (default `compact`), `--wiring original|shuffled|disconnected`
(default `original`), `--seed <seed>` (42), `--seconds <n>` (at most 60, default 10), `--jev-every <seconds>`
(simulated seconds between paid decisions, default 2).

### Control lab

Open the Control tab. Targets, Waits, Recovery, Workflows and Choosers run retained or in-memory fixtures. Visual OCR
captures a real native window, overlays OCR regions, supports exact or Jev selection, and dispatches only after you
click the explicit **Click selected region** button. Captures have a 30 second action lifetime; a changed image, a
replaced app or window, or a reused capture is refused. The local server keeps at most four captures for two minutes
and removes its own files on expiry, eviction and shutdown. No icon model or Python is involved. Live policy drives
`route`, `compact`, `verify`, `observe`, `watch` and a `listen` session from the browser.

## Probably Lang lab (experimental)

A fun lab port of Probably 0.1 under `tools jev evaluation` (aliases `probably`, `prob`). Jev judges `feels`, `match`
and confidence; the default chat model handles `llm` and `write`. It is not a production language runtime.
Provenance: [lib/probably/NOTICE.md](lib/probably/NOTICE.md).

```bash
tools jev evaluation create                              # language guide and corpus
tools jev evaluation create --name inbox --bundle inbox  # save a bundled example
tools jev evaluation create --name mine --from ./mine.prob
tools jev evaluation list
tools jev evaluation show inbox
tools jev evaluation run inbox --input "Can you speak next month?"
tools jev evaluation run inbox --input @./message.txt
tools jev evaluation run inbox --input "Hello" --model xai/grok-4-fast
tools jev evaluation run hello                           # no model calls
tools jev evaluation run detox --replay recording.json   # deterministic replay
tools jev evaluation run inbox --input "Hello" --save recording.json
tools jev evaluation rm mine                             # aliases: remove, delete
```

`--input` takes literal text, `@path`, `-` for stdin, a JSON `{"input":"…"}`, or a path containing `/` or ending in
`.json`, `.jsonc` or `.txt`. `llm` and `write` use the chat task default (`tools ai config default set chat …`); if
none is set, pass `--model <ref>`. Programs are stored at `~/.genesis-tools/jev/probably/programs/<name>.prob`. The
live provider proof is `RUN_LIVE=1 bun run test src/jev/lib/probably/providers.live.test.ts`.

## How it works

### Where data lives

| Path | What |
|---|---|
| `~/.genesis-tools/jev/config.json` | key references and saved settings, mode 0600 |
| `~/.genesis-tools/security/vault.json` | the keys themselves, at `jev/<provider>/apiKey` |
| `~/.genesis-tools/jev/wake.json` | the wake marker |
| `~/.genesis-tools/jev/route-catalogue.json` | the `route` catalogue cache |
| `~/.genesis-tools/jev/grep-cache/` | `grep` answers, seven days |
| `~/.genesis-tools/jev/runs/` | `loop` run folders, newest 30 |
| `~/.genesis-tools/jev/probably/programs/` | Probably programs |
| `~/.genesis-tools/jev/cache/male-cns/` | arena circuits |
| `~/.genesis-tools/ai/usage/<date>.jsonl` | the usage ledger every model writes |
| `~/.genesis-tools/logs/<date>.log` | the day log `sessions` reads |

### What it calls

- The TypeSafe API (`https://api.typesafe.ai/v1`) or Vercel AI Gateway for every paid Jev call. The gateway credit
  balance comes from `https://ai-gateway.vercel.sh/v1/credits`.
- `tools ai` accounts for the STT providers of `listen` and for the chat model of the Probably lab and `--writer`.
- The native control core (`tools control`, ax-tool, Vision OCR) for `listen`, `loop`, `watch`, `look` and
  `control`.
- A Chrome or Brave with a DevTools port for the browser surface (`src/chrome-devtools/lib/`).
- GenesisTools.app for the microphone (`--pcm-in mic`) and the voice capsule.
- `tools artifact` for the dashboard.

### What it needs on the Mac

The live-control verbs need the grants `tools control` needs: Accessibility, Screen Recording, and Automation.
`tools jev control doctor` reports each one without prompting and exits 1 while one is missing;
`tools jev control permissions` asks macOS for them. The microphone grant belongs to GenesisTools.app.

### What costs money

Every Jev call is priced from the model catalog ($0.042 per million input tokens, output free) and booked in the
shared usage ledger under app `jev` (provider `jev-vercel` or `jev-typesafe`), with a label: the explicit
`usageLabel`, or else the running command (`jev listen`, `control fill`, ...). The evaluator's
`Jev evaluation done` log line carries the call's `costUsd` and the running total of the process.

```bash
tools jev spend                         # by feature, by model, by day
tools jev spend --from 2026-09-01 --json
tools ai-spend jev session              # the same rows in ai-spend; also daily and monthly
```

The ledger is `~/.genesis-tools/ai/usage/<date>.jsonl`, written through `recordUsage`, the same store every other
model writes to; `queryUsage` and the dev-dashboard AI accounts spend view read it. The dev-dashboard spend block
shows the same rows when its source is `calls` or `both`. Rows booked before the
catalog knew Jev are priced when read. The shared reader is `src/utils/ai/evaluation/spend.ts`.

No Jev call: `demo --example`, `demo reel`, `control demo`, `experiment state`, `replay`, `sessions`, `wake`, `config`,
`arena circuits`, `arena load`, `arena simulate` in `human` or `malecns` mode, `evaluation run` on a program without
model calls or with `--replay`, and every `--help`.

### Code layout

- `commands/`: thin CLI adapters, one file per verb.
- `lib/`: request validation, provider access, errors, grammar, token decisions, type-check and run, the arena, grep,
  listen, loop, route, screen, wake, and the local HTTP adapter in `lib/server/`.
- `dashboard/`: the artifact entry, the browser client and the shared-theme styles.
- `mcp/`: the MCP server and its tools.

The CLI and the HTTP routes call the same library functions. The experiment pipeline does not depend on TypeScript:
`ExperimentLanguage` defines source generation and metadata (`TypeScriptLanguage` is registered in
`LanguageRegistry`), `GenerationMode` is implemented by `GrammarTokenMode` and `CharacterMode`, and
`LanguageCompiler.prepare()` returns a checker and runtime plan (`TypeScriptCompiler` uses tsgo and Bun, registered
in `CompilerRegistry`). `compiler.ts` owns process execution, deadlines, cancellation, output limits and the sandbox.
To add a language, implement and register its language and compiler classes. Character mode can use the new language
without grammar changes; constrained mode needs that language's token-state implementation. The dashboard exposes
TypeScript only, on purpose.

`lib/arena/` owns the graph contract and cache, the simulator, the game rules, the policy and the headless runner.
The CLI, the HTTP routes, the browser worker and the dashboard use that shared core.

## Configuration

### Credentials

```bash
tools jev login                               # TypeSafe, masked prompt
tools jev login --provider vercel             # Vercel AI Gateway
printf '%s' "$KEY" | tools jev login --stdin  # a piped key, no browser
```

`login` opens the provider's key page (the TypeSafe console, or Vercel's AI Gateway API keys page), then asks for
the key in a masked prompt. The key goes into the GenesisTools vault (`~/.genesis-tools/security/vault.json`,
AES-256-GCM) at `jev/<provider>/apiKey`. `~/.genesis-tools/jev/config.json` holds only a reference to it (`apiKey` for
Vercel, `typesafeApiKey` for TypeSafe). Logging in to one provider keeps the other provider's key. The key is never
printed. A plaintext key saved by an older version is still read and moves into the vault on first use.

The lookup order per provider:

1. The environment: `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY`.
2. The saved key.
3. Vercel only: `VERCEL_OIDC_TOKEN`. OIDC tokens expire; the command does not rotate them or log in to Vercel.

Do not put keys in command arguments or tracked files. The Codex Vercel plugin connection and this CLI's AI Gateway
credential are separate.

### Saved settings

`tools jev config` (also `tools jev control config`) saves defaults beside the credentials in
`~/.genesis-tools/jev/config.json`, under one `settings` object. A flag always wins over a saved value, and a saved
value always wins over the built-in default. `config show` prints each value and where it comes from.

```bash
tools jev config show
tools jev config set provider vercel
tools jev config set scope window
tools jev config unset gate
```

| Key | Values | Default |
|---|---|---|
| `provider` | `typesafe`, `vercel` | `typesafe` |
| `scope` | `auto`, `window`, `chrome` | `auto` |
| `menus` | `on`, `off` | `on` |
| `stt` | an STT provider | `deepgram` |
| `language` | ISO 639-1 codes | `auto` |
| `gate` | above 0, at most 1 | `0.8` |
| `maxSeconds` | listen budget, seconds | `60` |
| `confirmRisk` | `off`, `medium`, `high` | `off` |
| `narrowAt` | candidate count | `25` |
| `speak` | `off`, `decisions`, `all` | `off` |
| `historyDepth` | past asks per choice | `5` |
| `browser.port` | CDP port (no effect yet) | `9222` |
| `cursorOverlay` | `on`, `off` | `on` |
| `focusStealGuard` | `always`, `agents`, `off` | `always` |

- `confirmRisk` asks for a spoken confirmation at or above that risk, whatever the probability.
- `narrowAt` is how many candidates make a screen ambiguous enough to offer the narrowing rows.
- `speak` says the chosen label aloud.
- `historyDepth` is how many past asks travel with each choice; a higher value resolves "the third one".
- `browser.port` is saved and shown, but `listen` and `loop` do not use it yet: the `--port` flag's own default of
  9222 always wins. Pass `--port` for another port.
- `cursorOverlay` draws the cursor overlay where an act landed, so a watching person sees it.
- `focusStealGuard` decides when `control type`, `set` and `hotkey` refuse while another app is frontmost: always,
  only when an agent runs them, or never. `--steal-focus` lifts it for one call.

A saved settings object that fails the schema is ignored with a warning on read, and a `config set` or `unset`
refuses to touch it (see Troubleshooting).

### Environment variables

- `TYPESAFE_API_KEY`, `AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN`: credentials, above.
- `PROFILE=jev-evaluate,control-native,jev-listen`: timings in the profiling log (scopes in
  `src/utils/profile/scopes.ts`).
- `RUN_LIVE=1`: enables the live Probably provider test.
- `GENESIS_TOOLS_NO_WAKE=1`: `tools jev wake enable` refuses, and `wake status` shows `blocked: true`.

## For agents

- **Output.** `ask`, `run`, `demo`, `look`, `route`, `compact`, `verify` and `screen` print JSON on stdout (for
  `verify` and `screen`, `--json` only keeps the raw Jev payload). `grep` prints a text
  packet that ends with `End context.`, or one object with `--json`. `sessions`, `spend`, `config show`,
  `evaluation list` and `replay` take `--json`. `listen`, `loop` and `watch` take `--json` for the full result with
  snapshot tokens.
- **Exit codes.** `grep`: 0 complete (also when nothing matched), 1 bad arguments or credentials, 2 incomplete
  discovery, 130 interrupted (the evidence so far is still printed). `verify` and `screen` with `--gate`: 2 when a gate
  rule fires. `look`: 1 when no region resolved. `route`: 1 when no command was admitted, 1 when `--run` refuses to
  run, otherwise the routed command's own exit code with `--run`; 2 when `--plan` stops at a destructive step; 1 when
  `--suggest` finds no rows. A failed command exits 1 and prints the first line of the error on stderr; the full
  error is in the day log.
- **MCP.** `tools jev mcp` serves the read-only tools `jev_route`, `jev_compact`, `jev_verify`,
  `jev_verify_templates` and `jev_grep` on stdio. The same tools appear on `tools genesis-tools-mcp` under the
  capability `jev`. None of them acts on the machine.
- **Plugin skills.** `gt:jev-grep` (when and how to call `grep` and read its packet) and `macos-control`, with no
  `gt:` prefix (the control stack that `jev control` shares). Both ship in the genesis-tools plugin.
- **Worktrees.** In a linked worktree, run `./tools jev …` from the worktree root. The `tools` on PATH runs the main
  checkout.

## Troubleshooting

- **`customer_verification_required` from Vercel.** Vercel may require a credit card on the account before it serves
  requests, even requests covered by free credits. This is an account block, not a bad key. The CLI prints Vercel's
  verification link.
- **A free-tier restriction from Vercel.** Jev is restricted to purchased AI Gateway credits; the free credit balance
  alone does not grant access. Use the top-up link the gateway reports, or switch to `--provider typesafe`.
- **`Service temporarily unavailable` from Vercel.** The gateway drops requests often enough to lose live utterances.
  Use the default `typesafe` provider.
- **`No <provider> credential. Run tools jev login … or set …`.** Nothing was found in the environment, the vault or
  (for Vercel) `VERCEL_OIDC_TOKEN`. If a key was saved, the vault may be unreachable (no master key); the day log has
  `Could not read the saved Jev credential from the vault`.
- **`Zero Data Retention enforcement is only supported by the Vercel adapter.`** `--zdr` with the TypeSafe provider.
  Add `--provider vercel` or drop `--zdr`.
- **`The saved Jev settings in … fail the schema (…)`.** A hand edit broke the `settings` object in
  `~/.genesis-tools/jev/config.json`. Reads ignore the whole object; writes refuse so that no other key is erased. Fix
  or remove the named keys.
- **`listen` controls the wrong window.** It was started from a terminal and fell back to z-order. Focus the app
  before the first utterance, or pass `--app`.
- **`listen` on a browser fails on the first utterance (with `--continuous`, a `skipped` line on each one).** A
  browser target takes the CDP surface by itself, so `listen` needs a DevTools port (9222 unless `--port` says
  otherwise). Start the
  browser with a DevTools port, or pass `--surface ax` to fall back to the accessibility tree, which sees only the
  tab strip and toolbar.
- **`listen` abstains on everything inside a web page.** It runs on the AX surface (`--surface ax` or `auto`), and
  the AX tree cannot reach the page. Drop `--surface ax`, or use `--surface browser`, with a DevTools port.
- **`listen` ignores the wake marker.** It takes only the marker's languages. Pass `--wake-mode`, `--stt` and
  `--wake` yourself.
- **`listen` from a pipe fails with `Unknown STT provider ''`.** There is no default STT provider outside a terminal.
  Pass `--stt`, or `--transcript` for the fixture provider.
- **A `grep` packet without `End context.`** The output was cut. Treat it as truncated.
- **`grep` prints `Warning: "budget_..."`.** The budget left directories, files or sources out. Narrow the root or
  raise `--budget`.

To debug a decision, read the day log (`~/.genesis-tools/logs/<date>.log`). Every decision layer writes under its own
`component`:

- `jev-evaluate`: one line per Jev call with the model, questions, answers, token usage and running totals.
- `control-gate`: every admission verdict with probability, margin and confidence.
- `control-native`: every ax-tool `see` and `act` with duration and result.
- `control-observe` (the fan-out decision), `control-assist` (each guard: double-toggle, recovery, no-change),
  `control-recovery`, `control-menu`.
- `jev-listen` (each listen decision with its readback) and `jev-prefetch`.

```bash
rg '"component":"control-gate"' ~/.genesis-tools/logs/$(date +%F).log | tail -5
# A day before yesterday is <day>.log.zst. Read it with rg -z, or with:
#   tools compress cat ~/.genesis-tools/logs/<day>.log | rg ...
PROFILE=jev-evaluate,control-native tools jev listen \
  --app Calculator \
  --transcript session.jsonl \
  --stt fixture
```

## Related

- [tools control](../control/README.md): the native control core that `jev control`, `listen`, `loop` and `watch`
  use.
- [tools computer-use](../computer-use/README.md): the native computer API and its MCP server.
- [tools chrome-devtools](../chrome-devtools/README.md): the CDP page driver behind the browser surface.
- [tools ai](../ai/README.md): accounts for the STT providers and the chat model.
- [tools ai-spend](../ai-spend/README.md): Jev cost beside every other model.
- [tools artifact](../artifact/README.md): the engine the dashboard runs on.
- [tools genesis-tools-mcp](../genesis-tools-mcp/README.md): serves the Jev MCP tools with the question tools.
