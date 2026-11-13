# tools ask

A command-line chat client for many LLM providers through one interface: OpenAI, Anthropic, Google, Groq,
OpenRouter, xAI and Jina AI with API keys, plus Claude, ChatGPT (Codex), Grok and GitHub Copilot subscription accounts
and the GenesisTools ai-proxy. Ask one question from a script, chat in the terminal with file and shell tools,
transcribe an audio file, compare model prices, and see what your calls cost.

## Quick start

```bash
tools ask                                                # open the chat: pick a provider and a model, then type
tools ask -p openai -m gpt-4o-mini "What is a monad?"    # one question; the answer streams to the terminal
echo "Name three sorting algorithms" | tools ask -p openai -m gpt-4o-mini --raw   # stdin is the question
tools ask -m sonnet "Summarize @README.md"               # part of a model name; @ attaches a file that must exist
tools ask models --provider openai                       # the models you can use, with prices per 1M tokens
tools ask usage --days 7                                 # what tools ask cost you in the last 7 days
```

You need one provider first: export a key (`export OPENAI_API_KEY=...`) or add an account with `tools ask config`
(see [Configuration](#configuration)). GenesisTools itself installs from the repository root with
`bun install && ./install.sh`, then `source ~/.zshrc` (or `~/.bashrc`).

## Commands

| Command | What it does |
|---|---|
| `tools ask [prompt...]` | Ask one question, or open the chat when there is no prompt |
| `tools ask --sst <file>` | Transcribe an audio file |
| `tools ask models` (also `model`) | List the models of every detected provider, with prices |
| `tools ask usage` | Tokens and cost from the local usage database |
| `tools ask config` (also `configure`) | Interactive wizard: accounts, default model, provider switches |

`tools ask --help` lists every flag. `tools ask --help-full` (short form `-?`, which zsh needs quoted: `'-?'`) prints
a longer help with examples and the chat commands, but parts of it are older than the code: it spells `--maxTokens`
and `--systemPrompt`, says `-i` is the default, and names `ASK_CONVERSATIONS_DIR`, which nothing reads. Trust `--help`
and this page for spellings.
`tools ask --readme` prints this page, and `tools ask -V` prints the version.

### Ask a question (the default command)

```text
tools ask [options] [prompt...]
```

Which mode runs:

- No prompt, in a terminal: the [chat](#chat-interactive-mode) opens.
- A prompt: one question, one answer, then the command exits.
- No prompt and stdin is piped: the whole of stdin is the question. When you also give a prompt, stdin is not read;
  attach a file with `@` instead.
- `-i, --interactive` forces the chat. It needs a terminal, and it ignores a prompt given with it.

| Flag | Meaning |
|---|---|
| `-m, --model <name>` | Model id or display name; part of one also works (below) |
| `-p, --provider [name]` | Provider name ([table](#providers-and-accounts)); always give it a value (below) |
| `-f, --format <fmt>` | `text` (default), `json`, `jsonl`, `markdown`, `clipboard` |
| `-o, --output <file>` | Write the answer to a file; wins over `-f` |
| `--raw` | Print only the answer text: no status lines, no cost, no `usage` row (an `@file` still adds one line) |
| `--cost` | Print a cost table after the answer |
| `--predict-cost` | Print an estimate before sending; it does not ask to confirm, and `--raw` skips it |
| `--system-prompt <text>` | System prompt, at most 10,000 characters |
| `-t, --temperature <n>` | 0 to 2; dropped for Claude 4.7 and later and for Fable, which reject it |
| `-k, --max-tokens <n>` | 1 to 100,000 |
| `--no-context` | Do not add the project's `.genesistoolscontext.json` artifacts |
| `--no-tools` | Give the model no tools: no file reads, grep, shell or web search |
| `--silent` | Hide the status lines (detected providers, `Using ...`, `Thinking...`), but not the `@file` and `--predict-cost` lines |
| `--streaming`, `--no-streaming` | Chat only; read [Troubleshooting](#troubleshooting) first |
| `-v, --verbose` | Accepted, but it does not change the log level; use `LOG_DEBUG=1` |
| `-s, --sst <file>` | [Transcribe](#audio-transcription---sst) instead of chatting |
| `--sort`, `--filter-capabilities` | Used by [`models`](#tools-ask-models) |

A bare `-p` is the same as no `-p`: the saved default applies, and a picker opens only when no provider and model
resolve. The value is optional, so `tools ask -p "question"` takes the question as the provider name and, with no
prompt left, opens the chat. Give `-p` a value.

**How the model is chosen** for one question:

1. `-m` and `-p` from the command line. Without them, the ask default from the AI config (set it in `tools ask config`,
   "Default provider & model").
2. The name is matched against the models of the detected providers. An exact id or display name is used at once.
   Otherwise every model whose id or name contains the text matches, ignoring case. The search stays inside `-p` first
   and widens to every provider when nothing matches there, so `-m gpt-4o` works while the default provider is
   anthropic.
3. When stdout is a terminal, a partial match always opens a picker (up to 15 rows) so you confirm the choice. When
   stdout is piped, one match is used and several matches exit 1.
4. In a terminal with no model at all, the picker opens. After you pick, ask prints the same call as a
   `-p ... -m ...` command for next time.
5. When stdin is piped, the provider and the model must resolve, or the command exits 1. It prints up to 8 "Did you
   mean" lines when you gave a model, and every detected provider with its first three models. When only stdout is piped, it exits 1 with
   `Provider (-p) and model (-m) are required for non-interactive mode` and no suggestions.

**Attach files with `@`.** A word such as `@src/app.ts` (an `@`, then a path that ends in a file extension) attaches
that file: ask appends its content to your message as a fenced code block and prints `Attached 1 file: ...` on
stdout, also with `--raw`, `--silent` or `-f json`. Paths are relative to the current folder. There is no size limit,
so a large file costs tokens. `@alice` (no dot) stays text. Any `@` followed by a word with a dot that is not a file
hangs the command today: an email address (`alice@example.com`), a package version (`react@18.2.0`) or `@v1.2`. This
holds for a prompt, for piped stdin and for a chat message; see [Troubleshooting](#troubleshooting). Only your message
is searched for `@` words, never the content of an attached file.

**Answer formats.** `text` streams as it arrives (Markdown is rendered in a terminal, tool calls go to stderr). Every
other format waits for the whole answer:

- `json`: `{ "content": "...", "timestamp": "..." }` on stdout. The `Using` and `Thinking` status lines are hidden,
  but an `@file` and `--predict-cost` each still print one line before the JSON.
- `jsonl`: the same object on one line.
- `markdown`: the answer as Markdown.
- `clipboard`: copies the answer and prints `✓ Content copied to clipboard`.
- `-o <file>`: writes the answer, creates missing folders, and prints the path and the file size.

`--predict-cost` counts about 4 characters per token in your message and assumes 500 output tokens. It ignores the
system prompt, the project context and tool calls, so treat it as a lower bound. It prints on stdout, and `--raw`
skips it.

### Chat (interactive mode)

Run `tools ask` with no prompt in a terminal.

- The chat always opens the provider and model picker, even with `-m`, `-p` or a saved default (those apply to one
  question). With one provider the provider step is skipped. The model list is a search: type to filter. Each row
  shows the context size, the input and output price per 1M tokens, and capability letters: `V` vision, `F` function
  calling, `R` reasoning.
- The conversation, tool calls included, goes with every next message. The model has the
  [tools](#what-a-question-sends) unless you pass `--no-tools`.
- After each answer the chat prints the response time, and a cost table when the answer cost more than $0.001.
- The conversation is saved every five exchanges (10 messages) and at exit, to
  `~/.genesis-tools/ask/conversations/<session-id>.json`.
- Ctrl+C once prints `Press Ctrl+C again to quit.`; a second Ctrl+C within 2 seconds exits.

| Command | What it does |
|---|---|
| `/model` | Pick another provider and model; the history stays |
| `/clear` | Clear the conversation history |
| `/save` | Save a copy now, under a new session id |
| `/sst [file]` | Transcribe an audio file (asks for the path) and send the text as your message |
| `/context` | Show the first 15 lines of the system prompt, with the loaded project context |
| `/system` | Show the system prompt (first 500 characters) |
| `/tools` | List the tools the model has |
| `/history` | Message count and estimated tokens |
| `/output <format>` | Accepted, but not applied yet: answers always stream as text |
| `/help` | List the commands |
| `/quit`, `/exit` | Save and exit |

The prompt refuses any other `/word`.

### Audio transcription (--sst)

```bash
tools ask --sst meeting.m4a                  # a Provider/Model header, then the transcript, on stdout
tools ask --sst meeting.m4a -f json          # {content, timestamp, metadata: {provider, model, processingTime}}
tools ask --sst meeting.m4a -o meeting.txt   # write the transcript to a file
```

- `--sst` always prints two status lines on stdout: `Transcribing audio...` before the output and
  `Transcription completed in ...` after it. `-f json`, `--raw` and `--silent` do not hide them, so a script must
  strip them ([For agents](#for-agents)).
- Formats: mp3, wav, m4a, aac, ogg, flac, webm, mp4. The file may be at most 500 MB.
- The provider and model come from the AI config's `transcribe` default
  (`tools ai config default set transcribe <model-ref>`), else from its resolution ladder over the accounts and keys
  you have.
- An upload to a cloud provider above 24 MB is split into chunks (OpenAI and Groq reject files above 25 MB).
- `--sst` takes no prompt: `Cannot use --sst and provide a message simultaneously`.
- For language hints, speakers or SRT and VTT output, use [`tools transcribe`](../transcribe/README.md).

### tools ask models

Shows the models of every provider ask can use right now, one table per provider, then a summary.

```bash
tools ask models                                    # every detected provider, cheapest input first
tools ask models --provider openai                  # one provider (-p works too)
tools ask models --sort price_output                # or input, price_input (default), output, name
tools ask models --filter-capabilities "vision|functions"   # models that have BOTH capabilities
tools ask models --format json                      # machine-readable; --sort is ignored here
```

- Columns: Model Name, ID, Context, Input/1M, Output/1M, Cached/1M (cache read) and Capabilities. A price of 0 shows
  as `Free`, an unknown price as `N/A`.
- `--filter-capabilities` keeps a model only when it has every listed capability. `functions` and `function-calling`
  are the same capability. Other names: `chat`, `vision`, `reasoning`.
- The table hides OpenRouter's Auto Router entries and any price below 0 or above $1,000,000 per 1M tokens.
- The summary prints the provider and model counts, the cheapest and the most expensive input price, how many models
  have tiered pricing (a higher rate above 200K tokens, as Claude models have), the capability counts, and the
  largest, smallest and average context window.
- `--format` here accepts `table` (default) or `json`.
- A `--provider` that matches no detected provider prints `No providers found matching "<name>"` and exits 0.

### tools ask usage

Reports on the local usage database that ask writes after each answer: how much you spent, how many tokens went
through which model, and which days cost the most. It was `tools usage` until 2026-10-05; `tools usage` still works and
prints ``note: `tools usage` is an alias for `tools ask usage` `` on stderr.

```bash
tools ask usage                      # last 30 days: summary, daily table, by provider, by model, 7-day trend
tools ask usage --days 7
tools ask usage --provider openai
tools ask usage --model gpt-4o-mini
tools ask usage --format summary     # totals only
tools ask usage --format json        # for scripts and dashboards
```

| Option | Description | Default |
|---|---|---|
| `-d, --days <n>` | Days to analyze; a positive whole number | `30` |
| `-p, --provider <name>` | Only this provider | all |
| `-m, --model <name>` | Only this model | all |
| `-f, --format <fmt>` | `table`, `json` or `summary` | `table` |
| `-v, --verbose` | Verbose logging (this one changes the console level here) | off |
| `--readme` | Print this page | |
| `-?, --help-full` | Detailed help with examples | |

`models` and `config` have no help of their own: `--help` after them prints the main `tools ask` help.

The table view shows totals (cost, tokens, messages, sessions, average cost and tokens per message), a daily table,
a table by provider (one row each), the top 10 models, and a bar chart of the last 7 days. A report adds up the costs stored with
each row and fetches no prices, so past totals do not change when rates change ([Cost](#cost)). For Claude Code
session costs use [`tools claude usage`](../claude/README.md); for coding-agent token analytics use
[`tools ai-spend`](../ai-spend/README.md).

### tools ask config

An interactive wizard (it needs a terminal). The menu loops until you pick Exit:

- **Manage accounts**: list, view and remove accounts, or add one.
  - Anthropic: take an existing `tools claude` account, log in to the Claude Max plan in the browser, paste an OAuth
    token from `claude setup-token`, or paste an API key.
  - OpenAI / Codex: import the Codex CLI login (`~/.codex/auth.json`; run `codex login` first), sign in with ChatGPT
    (open the link, then paste the authorization code), or paste an API key.
  - Every other provider: `tools ai config account add --provider <id>`.
- **Default provider & model**: set the default for one-shot questions, or unset both, only the model, or only the
  provider.
- **Provider settings**: one switch for "auto-detection of provider API keys from environment", then a choice of
  which of openai, groq, openrouter, anthropic, google, xai and jinaai stay on.
- **Show current config**: the accounts, the default, and the providers that are off.

## How it works

### Providers and accounts

ask uses the shared AI accounts of GenesisTools (`~/.genesis-tools/ai/config.json`, secrets in the vault at
`~/.genesis-tools/security/vault.json`; see [`tools ai`](../ai/README.md)). On every run it walks the enabled
accounts whose provider can chat and binds each one. Then it adds a temporary entry for each provider variable set in
your environment that has no account of that provider. Nothing is written for those entries, and the key is read
live.

A subscription account and an API key of the same vendor share one provider name (`anthropic-sub` answers as
`anthropic`, `openai-sub` as `openai`), and each name is served by one account only. The first one wins:

1. the account set as the chat default (`tools ai config default set chat @account/<id>`);
2. the other real accounts, in the order openai, groq, openrouter, anthropic, google, xai, jinaai, then the rest;
3. an environment key, last. So a configured Claude subscription wins over a stray `ANTHROPIC_API_KEY`.

In a terminal, the `Using openai/gpt-4o-mini (work, pro)` line names the account that answers.

| `-p` name | Comes from |
|---|---|
| `openai` | `OPENAI_API_KEY`, or an OpenAI or ChatGPT (Codex) account |
| `anthropic` | `ANTHROPIC_API_KEY`, or an Anthropic or Claude subscription account |
| `google` | `GOOGLE_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` |
| `groq` | `GROQ_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` (model ids look like `anthropic/claude-sonnet-5.5`) |
| `xai` | `XAI_API_KEY` or `X_AI_API_KEY` |
| `grok` | a Grok subscription account |
| `jinaai` | `JINA_AI_API_KEY` |
| `github-copilot` | a GitHub Copilot account |
| `ai-proxy` | the GenesisTools proxy, registered with `tools ai-proxy link` |

The model list of each provider comes from the model catalog (`src/utils/ai/catalog/`), not from live `/v1/models`
calls. OpenRouter is the exception: its list adds the live `https://openrouter.ai/api/v1/models` catalog, cached in
`~/.genesis-tools/ai/cache/openrouter-models.json` and refreshed after 6 hours. `tools ask models --provider <name>`
shows the list. OpenAI models go to the Chat Completions API, except codex models, `gpt-5-pro` and `gpt-5.N-pro`,
and every model of a ChatGPT (Codex) subscription, which use the Responses API. The reasoning is in
[docs/selecting-mode-decision.md](docs/selecting-mode-decision.md).

### What a question sends

- **Your system prompt**, if you gave one, plus the **project context**. ask walks up from the current folder to the
  nearest `.genesistoolscontext.json` (the file [`tools indexer`](../indexer/README.md) also uses), reads each listed
  artifact file, and appends them under `# Project context`. The budget is 4,000 tokens in total, split evenly with
  at least 200 per artifact. A longer file is cut and marked `…(truncated)`. Only files are read, so a folder
  artifact is skipped. `--no-context` turns this off.
- **Your message**, with the content of every `@file`.
- **A subscription prefix.** A Claude subscription account puts its required system prompt prefix (`You are Claude
  Code, Anthropic's official CLI for Claude.`) before your system prompt, also with `--no-context`. `/system` and
  `/context` do not show it.
- **Tools**, unless you pass `--no-tools`. With tools on, one message may take up to 5 model steps.

| Tool | What the model can do |
|---|---|
| `readFile` | Read any file, optionally only the first N lines |
| `grep` | Run ripgrep; the output is cut at 5,000 characters on success; an error returns in full |
| `bash` | Run a zsh command in the current folder; 10 s timeout by default, output cut at 10,000 characters on success; an error returns in full |
| `searchWeb` | Brave web search, up to 10 results from the past day (only with `BRAVE_API_KEY`) |

The model runs `bash` commands without asking you first. Pass `--no-tools` when the question or an attached file
comes from someone you do not trust.

### Where data lives

| Path | What it holds |
|---|---|
| `~/.genesis-tools/ai/config.json` | Accounts and defaults, shared with every AI tool |
| `~/.genesis-tools/security/vault.json` | API keys and tokens of those accounts |
| `~/.genesis-tools/ask/config.json` | Legacy ask settings the wizard still writes ([below](#legacy-ask-configjson)) |
| `~/.genesis-tools/ask.sqlite` | Usage rows (`usage_records`) for `tools ask usage` |
| `~/.genesis-tools/ask/conversations/` | Saved chats, one `<session-id>.json` each |
| `~/.genesis-tools/ai/usage/YYYY-MM-DD.jsonl` | The shared usage log of every AI call, one file per UTC day |
| `~/.genesis-tools/ask/cache/litellm-pricing.json` | LiteLLM's price list, fetched again after one day |
| `~/.genesis-tools/ai/cache/openrouter-models.json` | OpenRouter's model catalog |
| `~/.genesis-tools/logs/YYYY-MM-DD.log` | The day log of every tool |

- The database opens on first use, so `tools ask --help` writes nothing (2026-10-05, #446).
- A session id is the UTC start time plus six hex characters, such as `2026-11-09_14-03-27-123_a1b2c3`. Each
  conversation file holds the messages, `endTime`, `totalUsage` and `totalCost`. No command reads them back yet.
- `GENESIS_TOOLS_HOME` moves the whole `~/.genesis-tools` root.

### Cost

- An API key is billed per token by its vendor. A subscription account spends the plan's limits. Web search spends
  Brave quota. A transcription is billed by its provider.
- Each answer is priced when it is recorded: the curated catalog first, then LiteLLM, then OpenRouter (OpenRouter
  prices only for `openrouter` calls). Cache reads and
  writes have their own rates, and a context-banded rate (such as a higher rate above 200K tokens) is chosen from the
  full prompt, cache tokens included. A model with no known price is recorded at $0, and the log says
  `Could not determine pricing for <provider>/<model>`.
- Two ledgers record calls. `~/.genesis-tools/ask.sqlite` gets one-shot answers and chat answers; `--raw` answers,
  `/sst` follow-ups in the chat and calls from the `AIChat` library do not reach it. The shared log
  `~/.genesis-tools/ai/usage/` gets every call that goes through the shared transport, with the app name `ask`.
- Network: the provider's API, `api.search.brave.com` for web search, `raw.githubusercontent.com` for the LiteLLM
  price list, and OpenRouter for its catalog.

ask needs no macOS permission. `clipboard` uses the system clipboard, the `bash` tool needs zsh, and `grep` uses the
bundled ripgrep or `rg` on PATH.

## Configuration

### Keys in the AI config

These live in `~/.genesis-tools/ai/config.json`. Change them with `tools ask config` or `tools ai config`; never edit
the file by hand.

| Key | Effect on ask |
|---|---|
| `defaults.app.ask.chat` | `{ provider, model }`, the default for one-shot questions |
| `defaults.account.chat` | `@account/<id>`, the account that answers first under its provider name |
| `defaults.task.transcribe` | The model `--sst` uses |
| `disabledProviders` | Providers that ask skips (written by "Provider settings") |

The ask default can also be set without the wizard:

```bash
tools ai config default set chat gpt-4o-mini \
    --app ask \
    --provider openai
```

A provider in `disabledProviders` loses its environment key and its accounts of that exact provider id. A
subscription account has its own id (`anthropic-sub`), so turning `anthropic` off does not turn it off.

### Environment variables

| Variable | Used for |
|---|---|
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY` | Chat providers |
| `OPENROUTER_API_KEY`, `JINA_AI_API_KEY` | Chat providers |
| `GOOGLE_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` | Google |
| `XAI_API_KEY` or `X_AI_API_KEY` | xAI |
| `ASSEMBLYAI_API_KEY`, `DEEPGRAM_API_KEY`, `GLADIA_API_KEY` | Transcription providers for `--sst` |
| `BRAVE_API_KEY` | The `searchWeb` tool |
| `LOG_DEBUG=1`, `LOG_TRACE=1` | Console log level |
| `GENESIS_TOOLS_HOME` | Moves `~/.genesis-tools` |

`ASK_CONVERSATIONS_DIR` is no longer read: conversations always go to `~/.genesis-tools/ask/conversations/`.

### Legacy ask config.json

`~/.genesis-tools/ask/config.json` predates the shared accounts. When the wizard adds an Anthropic account from
`tools claude` or through the Max plan login, it writes `claude` (`accountRef`, `accountLabel` and `accountName` of
that account) and sets `defaultProvider` to `anthropic` when it is empty. It saves `envTokens` back as it found it
(default `{ "enabled": true }`). Only the wizard reads this file; questions and the chat use the AI config above. The
type also declares `maxTokens`, `temperature`, `costLimit`, `streaming` and `conversationsDir`, and nothing reads
them.

## For agents

```bash
tools ask -p openai -m gpt-4o-mini --raw --no-tools "Classify this title: ..."
echo "$PROMPT" | tools ask -p openai -m gpt-4o-mini --raw --no-tools
tools ask -p openai -m gpt-4o-mini -f json "..." | jq -r .content   # no @file, no --predict-cost
```

- Piped or prompt text that holds an `@` word with a dot (`react@18.2.0`) hangs the command. Put a space after the `@`,
  or write the text to an existing file and attach it as `@file.txt`: ask reads its content and never scans it for
  `@` words. A plain path without the `@` is sent as prompt text, not as the file's content.
- Pass `-p` and `-m` (or set a default). Without a terminal ask never opens a picker: a missing or ambiguous model
  exits 1 with suggestions on stderr.
- `--raw` prints the answer text on stdout, with a trailing newline. An `@file` attachment still adds an
  `Attached ...` line before it. It does not stream and it is not counted
  by `tools ask usage`.
- In text mode, the answer goes to stdout and the tool-call lines go to stderr.
- `--no-tools` keeps the model away from your shell; `--no-context` keeps the system prompt to what you pass.
- Exit codes: 0 on success, 1 on any failure (an invalid flag, a missing model, a provider error). `models` is the
  exception: with no matching provider it prints `No providers found` and exits 0.
- JSON shapes:
  - a question with `-f json`: `{ content, timestamp }`; `--sst -f json` adds `metadata`.
  - `models -f json`: an object keyed by provider name, each `{ name, type, description, models: [...] }`. A model
    has `id`, `name`, `contextWindow`, `capabilities` and `pricing` (`inputPer1M`, `outputPer1M`,
    `cachedReadPer1M`, `cachedCreatePer1M` and the same four with `Above200k`), or `pricing: null`.
  - `usage -f json`: `{ period: { days, startDate, endDate }, summary, daily, byProvider, byModel }`, where
    `summary` has `totalCost`, `totalTokens`, `messageCount`, `sessionCount`, `avgCostPerMessage` and
    `avgTokensPerMessage`.
- From TypeScript inside GenesisTools, use the library instead of a subprocess. `tools telegram` does:

```ts
import { AIChat } from "@app/ask/index.lib";

const chat = new AIChat({ provider: "openai", model: "gpt-4o-mini", systemPrompt: "Be brief." });
const reply = await chat.send("Hello");          // buffered: reply.content, reply.usage, reply.cost
for await (const event of chat.send("Tell me more")) {
    if (event.isText()) process.stdout.write(event.text);
}
```

  `index.lib.ts` also exports `ChatEngine`, `ChatSession`, `ModelSelector` and `ProviderManager`. A caller that
  passes `session: { autoSave: true }` (or calls `chat.session.save()`) gets its turns saved under
  `~/.genesis-tools/ai-chat/sessions/<id>.jsonl`.
- ask has no MCP server, no node-repl toolset and no plugin skill.

## Troubleshooting

Each entry names the symptom, then the cause and the fix.

- **`No AI providers detected.`** or **`No AI providers available`**: there is no account and no key. Export a key,
  or run `tools ask config` or `tools ai config account add --provider <id>`. `tools ai config doctor` checks the
  credential of every account.
- **`Missing provider and model for non-interactive mode.`**: there is no terminal, and `-p` or `-m` did not resolve.
  Pass both, or set a default. The "Did you mean" lines name real ids.
- **`Model "x" not found for provider "y".`**: the id is not in that provider's list.
  `tools ask models --provider y` shows the ids.
- **The command hangs with no output after a message with an email address or a version in it.** Any `@` followed by
  a word with a dot that is not a file (`alice@example.com`, `react@18.2.0`, `@v1.2`) makes the `@file` expander
  (`utils/at-mentions.ts`) loop forever.
  Put a space after the `@` or write `alice at example.com`. For piped text, write it to a file and attach it as
  `@file` only when the file exists. A probe on 2026-11-09 hung on `alice@example.com` for the full 5 s
  and returned at once for an existing `@probe.txt`.
- **`jq` fails on `--sst -f json` or on `-f json` with an `@file`.** ask prints status lines on stdout (`Transcribing
  audio...`, `Transcription completed in ...`, `Attached 1 file: ...`, the `--predict-cost` estimate) before or around
  the JSON, even with `--raw` or `--silent`. Strip the non-JSON lines, or avoid `@file` and `--predict-cost` in
  scripts.
- **`Provider (-p) and model (-m) are required for non-interactive mode`.** Only stdout is piped and the model did not
  resolve. Pass an exact `-p` and `-m`.
- **Piped text is ignored.** With a prompt argument, stdin is not read. Put the instruction in the piped text, or
  save the text to a file and attach it with `@`.
- **`BRAVE_API_KEY not found. Web search functionality will be disabled.`**: a warning only. Set `BRAVE_API_KEY`, or
  pass `--no-tools`.
- **The chat prints `Assistant:` and no answer.** That is `--no-streaming`: the chat prints streamed text only.
  Leave streaming on.
- **`/output`, `-f` or `-o` change nothing in the chat.** The chat stores the format but does not apply it yet. Use
  a one-shot question when you need a format.
- **The chat ignores `-m` and the default.** The chat always opens the picker; `-m`, `-p` and the saved default apply
  to one-shot questions only.
- **No cost table after a one-shot answer.** Pass `--cost`. The `--help` line says it is always shown in a terminal,
  but the code shows it only with `--cost`. The chat shows it for every answer above $0.001.
- **`tools ask usage` misses calls.** `--raw` answers, `/sst` follow-ups and library calls do not write
  `ask.sqlite`. The shared log in `~/.genesis-tools/ai/usage/` has them.
- **A cost of $0.** The model has no price in the catalog, LiteLLM or OpenRouter. The log line
  `Could not determine pricing for ...` names it.
- **The project context is missing.** Check `/context`. A folder artifact is skipped, and a broken
  `.genesistoolscontext.json` is logged at debug level as `[ask:context] failed to parse`.
- **`Interactive mode (-i) requires a TTY terminal.`**: `-i` in a pipe. Drop `-i` and pass the question.
- **`Temperature must be ...`**, **`Max tokens must be ...`**, **`System prompt too long ...`** or
  **`Invalid format: ...`**: a flag is out of range. The flag table above lists the limits.
- **`Unsupported audio format`** or **`File too large`**: `--sst` takes the listed formats, up to 500 MB.

### Logs

ask writes to the shared day log, `~/.genesis-tools/logs/YYYY-MM-DD.log` (pino JSON, one record per line). The file
keeps every level; the console shows `info` and above unless `LOG_DEBUG=1` or `LOG_TRACE=1` is set. `-v` does not
change the console level on a question or the chat; on `tools ask usage` it does. Only today and yesterday stay plain:
the daily pass stores an older day as `YYYY-MM-DD.log.zst`. Read one with
`tools genesis-tools logs day --tool ask --since <YYYY-MM-DD>`,
`tools compress cat ~/.genesis-tools/logs/YYYY-MM-DD.log | jq ...` (the plain name finds the `.zst`), or `rg -z`.
Failed runs are in `tools genesis-tools logs failures`.

```bash
LOG_DEBUG=1 tools ask -p openai -m gpt-4o-mini "test"             # debug lines on the console
tail -f ~/.genesis-tools/logs/$(date +%Y-%m-%d).log               # follow today's log
LOG=~/.genesis-tools/logs/$(date +%Y-%m-%d).log
tail -n 100 $LOG | jq -r 'select(.level >= 50) | .msg'            # the last errors
tail -n 50 $LOG | jq -r 'select(.level == 20) | .msg'             # the last debug messages
tail -n 20 $LOG | jq -r '[.time, .level, .msg] | @tsv'            # time, level and message
jq -r 'select(.msg | contains("provider")) | .msg' $LOG           # provider detection
jq -r 'select(.msg | contains("ChatEngine")) | .msg' $LOG         # chat engine debug lines
rg "ASK tool failed" $LOG                                         # the top-level failure line
```

Levels: 10 trace, 20 debug, 30 info (the console default), 40 warn, 50 error, 60 fatal.

## For contributors

- Map: `index.ts` (entry, modes, tool wiring), `utils/cli.ts` (flags, help, validation), `chat/ChatEngine.ts`
  (history and calls through the shared `coreChat`), `chat/CommandHandler.ts` (slash commands),
  `chat/ConversationManager.ts` (saved chats), `providers/ProviderManager.ts` (account detection),
  `providers/ModelSelector.ts` (pickers and fuzzy matching), `pricing/index.ts` (`models`), `commands/usage.ts` and
  `lib/usage-report.ts` (`usage`), `commands/configure.ts` (the wizard), `output/` (formats, cost, the usage
  database), `AIChat.ts` and `index.lib.ts` (the library). Transcription is shared code in
  `src/utils/ai/transcription/TranscriptionManager.ts`.
- A new provider is a plugin folder under `src/utils/ai/providers/plugins/`, with its models in the catalog
  (`src/utils/ai/catalog/static.ts`). Nothing in `src/ask/` changes; ProviderManager finds every chat-capable
  plugin. The rules are in `.claude/rules/ai.md` and `.claude/rules/models.md`.
- `./tools ask -p <provider> -m <id> "..."` from a worktree is the live check for a new model.
- Tests: `bun scripts/test.ts src/ask` (never bare `bun test`).
- The old `prompt`-not-`messages` workaround for single-turn calls is retired: `coreChat` sends messages on ai@7
  (`src/utils/ai/core/call.ts`). Style rules live in `.claude/rules/code.md`.
- A new provider also needs a row in `src/utils/ask/providers/compat.ts` for its detection priority and picker text;
  without one it ranks 99.
- [Plan.md](Plan.md) is the original design specification with dated progress notes.

## Related

- [`tools ai`](../ai/README.md): accounts, defaults, the vault and `tools ai config doctor`.
- [`tools claude`](../claude/README.md): Claude subscription logins and `tools claude usage`.
- [`tools ai-proxy`](../ai-proxy/README.md): the gateway that the `ai-proxy` provider talks to.
- [`tools ai-spend`](../ai-spend/README.md): token analytics of coding agents.
- [`tools transcribe`](../transcribe/README.md): transcription with languages, speakers and subtitles.
- [`tools indexer`](../indexer/README.md): `.genesistoolscontext.json` and its context artifacts.
- [`tools telegram`](../telegram/README.md): a bot built on the `AIChat` library.
