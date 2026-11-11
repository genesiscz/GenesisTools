# tools cursor

Ask Cursor's agent a question about a codebase and stream its answer into your terminal. The answer text goes to
stdout and Cursor's tool calls go to stderr, so you can pipe or save the answer while you still see what Cursor
read. Use it as a quick second opinion from another model when Claude Code or another agent is stuck.

## Quick start

```bash
# Ask about the repository in the current folder
tools cursor "which service creates the reservation?"

# Plan mode instead of ask mode: Cursor analyzes and proposes a plan
tools cursor --mode plan "outline a refactor of the auth layer"

# Pick a model
tools cursor --model gpt-5 "explain this file"

# Ask about another folder
tools cursor --workspace ~/Projects/app "where is the login form validated?"

# Only the answer text, with no tool calls, ready for a file or a pipe
tools cursor --raw "give me the summary" > answer.md

# A question that starts with a dash needs -- before it
tools cursor -- -why did this fail
```

## Options

`tools cursor` has no subcommands. It takes options and a question.

| Option              | What it does                                          | Default          |
| ------------------- | ----------------------------------------------------- | ---------------- |
| `<question>`        | The question: every word that is not an option        | required         |
| `--mode <mode>`     | `ask` or `plan`, the only modes the Cursor CLI takes  | `ask`            |
| `--model <model>`   | A Cursor model id, passed on unchecked                | Cursor's default |
| `--workspace <dir>` | The folder Cursor works in                            | current folder   |
| `--raw`             | Print only the answer text, no tool calls or status   | off              |
| `-h`, `--help`      | Print the help and exit 0                             |                  |
| `--readme`          | Print this README and exit 0                          |                  |
| `--`                | End of options: the rest is the question              |                  |

The parser is strict on purpose, so a typo never turns into part of the question:

- Each value option takes either form: `--mode plan` or `--mode=plan`.
- Options may stand anywhere before `--`. The other words join into the question with one space between them, so
  `tools cursor explain --model gpt-5 this file` asks "explain this file" with `gpt-5`.
- A missing or empty value is refused (`--model needs a value.`). A spaced value that looks like an option
  (`--model -x`) is refused as well. Write `--model=-x` when you mean it.
- An option the tool does not have is refused (`Unknown option --verbose.`), and so is a short one such as `-x`.
  A lone `-` is an ordinary word of the question.
- `--raw` takes no value: `--raw=1` is refused (`Unknown option --raw.`).
- A mode other than `ask` or `plan` is refused before Cursor starts
  (`Unknown --mode 'agent'. The Cursor CLI accepts: ask, plan.`).
- `-h` or `--help` anywhere before `--` prints the help, even next to a bad option.
- After `--`, every word is part of the question, even `--raw` or `-h`. The one exception is `--readme`: it prints
  the README wherever it stands, also after `--`, and the question is never asked.

Every refusal prints the reason and a hint to run `tools cursor --help`. A run with no question prints
`No question provided.` and a usage example. Both exit 1 and never start Cursor.

## Output

- **stdout**: the answer text, streamed as Cursor writes it. Cursor sends the whole text so far in each event; the
  tool prints only the new part, and adds a final line break after the text.
- **stderr** (without `--raw`): plain text, no colors, through the shared GenesisTools terminal renderer:
  - when Cursor starts, one line with the model and the folder Cursor works in, `<model> · <folder>`;
  - each tool call as `⏺ Name(arg: value, …)`, for example `⏺ Grep(…)` or `⏺ Glob(…)`;
  - each tool result, indented, as JSON cut to 500 characters (an error result shows the error text);
  - at the end, `success · 12.3s · 456 output tokens` (or `error · …`).
- Without `--raw`, a tool call that arrives in the middle of the answer adds a line break on stdout, so the text and
  the calls do not run together in the terminal. With `--raw`, stdout holds the answer text exactly as Cursor
  streamed it, and stderr stays empty unless Cursor fails.
- When Cursor exits with a non-zero code, its own error text (colors removed) is printed to stderr, also with
  `--raw`. When it succeeds, its stderr is not shown.

## How it works

The tool starts Cursor's agent command line in headless mode and reads its JSON event stream:

```bash
cursor agent \
    --mode=<mode> \
    --print \
    --stream-partial-output \
    --output-format stream-json \
    --trust \
    --workspace <dir> \
    [--model <model>] \
    -- "<question>"
```

- The question goes to Cursor as one argument after `--`, so Cursor never reads a word of it as its own option.
- `--workspace` is passed on as you wrote it. Cursor also accepts the name of a workspace you saved in Cursor.
- `--trust` accepts the workspace without Cursor's trust prompt, which would block a headless run.
- Both modes are read-only in the Cursor CLI's own help: `ask` answers questions and explains, `plan` analyzes and
  proposes plans with no edits. The tool never passes Cursor's `--force`, `--resume` or `--continue`, so each
  question starts a new Cursor chat that does not remember the last one.
- `CursorStreamAdapter` (`src/utils/agents/adapters/cursor.ts`) turns each event line into answer text or display
  blocks, and `TerminalRenderer` prints the blocks.
- The tool has no timeout of its own. It waits until Cursor ends, then exits with Cursor's exit code.

What it needs:

- The `cursor` command on your PATH, from a Cursor install, with a working `cursor agent`.
- A logged-in Cursor agent (see [Login](#login)).

Where data lives: the tool stores nothing of its own and has no config file. Cursor keeps its login and its chats
itself. Like every GenesisTools tool, a failed run (a refused command line, no question, a non-zero exit from
Cursor, a crash) is recorded in `~/.genesis-tools/logs/<date>-failures.jsonl`; `tools genesis-tools logs failures`
lists them. A record keeps the command line (the question included), the last 4000 characters of Cursor's stderr (tool
calls and results) and the folder the tool ran in. Only words that look like secrets are redacted, so a question about
private code stays on disk after a failure.

Cost: every question runs on your Cursor account and counts toward that account's usage.

## Login

The Cursor agent must be logged in. Run `cursor agent login` once (it opens a browser; set `NO_OPEN_BROWSER` to stop
that), or set `CURSOR_API_KEY` in the environment. When it is not logged in, `tools cursor` prints the CLI's own
`Authentication required` message and exits 1.

The Cursor flags above were checked against the help of the Cursor agent CLI 2026.10.01 on 2026-11-09 01:14. Run
`cursor agent --list-models` to see the model ids your account can use.

## For agents

- Call it with `--raw` and read stdout: `tools cursor --raw --mode ask "<question>"`. Quote the question as one
  shell word, and put `--` before it when it can start with a dash.
- Exit codes: `0` for a finished answer or the help; `1` for a refused command line or no question (Cursor never
  started), and also when the `cursor` command is not on PATH (Bun prints `Executable not found in $PATH: "cursor"`
  with a stack trace); otherwise Cursor's own exit code, which is `1` when the agent is logged out.
- There is no `--json` mode. The answer is plain text on stdout.
- Put a timeout on the call yourself. The `cursor` skill below uses 60 seconds.
- A Claude Code skill named `cursor` (a personal skill, not part of this repository's genesis-tools plugin) runs
  `tools cursor --raw --mode <mode> [--model <model>] "<prompt>"` and returns Cursor's answer into the
  conversation. It refuses a request for Cursor's `agent` mode, because the Cursor CLI no longer accepts it. It was
  verified on 2026-10-05 00:13 with a stand-in `cursor` (the answer streams, exit 0) and with the real CLI logged
  out (the auth error shows, exit 1).

## Troubleshooting

- **`Authentication required`, exit 1.** The Cursor agent is logged out. Run `cursor agent login`, or set
  `CURSOR_API_KEY`. Retrying without a login fails the same way.
- **`Executable not found in $PATH: "cursor"`.** The `cursor` command is not installed or not on your PATH. Install
  Cursor's shell command, then check that `cursor agent --help` prints the agent's help.
- **`Unknown --mode '…'`.** Only `ask` and `plan` exist. Cursor's full agent mode is not available through this
  tool.
- **`Unknown option …` for words of the question.** A word that starts with a dash is read as an option. Put `--`
  before the question: `tools cursor -- -why did this fail`.
- **The call runs for a long time.** The tool has no timeout and waits as long as Cursor works. Use a shorter
  question, a faster model (`--model`), or a narrower `--workspace`, and set a timeout in the caller.

## Related

- [tools ask](../ask/README.md): the multi-provider LLM client, for a question that does not need Cursor's agent.
- [tools claude](../claude/README.md) and [tools codex](../codex/README.md): the other agent command lines that
  GenesisTools drives.
- [tools genesis-tools](../genesis-tools/README.md): `logs failures` shows the failed runs of this tool.
