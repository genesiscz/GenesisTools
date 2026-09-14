# tools question

> **Ask the user a blocking question, and capture the questions fired at agents mid-session with their answers.**

Two directions, one store:

1. **Ask** — the agent posts a question and waits. The form shows up on the dashboard `/qa` Pending section, raises a notification, and releases the agent when it is answered. `ask`, `wait`, `poll`, `answer`, `cancel`.
2. **Log** — the agent records a question it already answered itself, so a substantive answer given halfway through a long session is not lost in scrollback within an hour. `record`, `log`, `tail`.

Answering a pending form also writes a normal log entry, so `/qa` shows one list rather than two. Wire contract for other clients: `docs/qa-pending-contract.md`.

---

## Commands

| Command | Description |
|---------|-------------|
| `ask` (alias `post`) | Ask the user a question and leave it pending until they answer |
| `wait <id>` | Block until a pending form is answered, cancelled or times out |
| `poll [ids…]` | Show pending forms, or the status of the ids you name |
| `answer <id>` | Answer a pending form from the terminal |
| `cancel <id>` | Withdraw a pending form; a blocked waiter is released as cancelled |
| `record` | Record a question and answer pair after the fact. Used by the `question_answer` MCP tool and by scripts. |
| `log` | Show recorded pairs, oldest first, last N entries |
| `tail` (alias `answers`) | Live feed of pairs as they are recorded, with a backlog |
| `config` | Read or update the sink config: sound, notify, Obsidian template |

### Asking

```bash
tools question ask -q "Ship the PR?" --choices yes,no          # prints the form, returns at once
tools question ask -q "Ship?" --choices yes,no --wait          # block until answered
tools question ask --json '[{"promptMarkdown":"Target?","choices":["staging","prod"]},{"promptMarkdown":"Notes?"}]'
tools question poll                                            # what is still waiting
tools question answer ask_5f1c… --choice yes
tools question cancel ask_5f1c…
```

`--wait` exits `0` answered, `2` timeout, `3` cancelled, `4` budget exhausted, so a script can branch on the outcome. `budget_exhausted` means your own wait ran out while the form is still pending; the form is alive and you may wait again.

| Flag | Description |
|------|-------------|
| `-q, --q <question>` | The question, markdown allowed |
| `--choices <list>` | Comma-separated choice labels |
| `--multiple` | Allow more than one choice |
| `--no-free-text` | Do not offer a free-text box |
| `--file-tags` | Allow `@file` tags, resolved against the form cwd |
| `--image-paste` | Allow pasted images |
| `--optional` | The item may be left blank |
| `--json <items>` | Multi-question form as a JSON array of items |
| `--timeout <ms>` | Auto-retire the form after this long |
| `--wait` / `--wait-timeout <ms>` | Block, and for how long (default 120000) |
| `--source <name>` / `--session <id>` | Who is asking, and the session to attribute the answer to |
| `--no-notify` | Do not raise a notification for this form |

## Quick start

```bash
tools question log                              # what has been captured
tools question log -l 20 --format ai
tools question log --unread
tools question log -p GenesisTools -t directive
tools question tail -n 5                        # backlog then follow
tools question config --list-sounds
tools question config --notify on --sound synth:soft
```

### `record` options

| Flag | Description |
|------|-------------|
| `--q <question>` | The question |
| `--a <answer>` | The answer, markdown allowed |
| `--a-file <path>` | Read the answer from a file instead |
| `--tag <tag>` | `question`, `action` or `directive` (default: `question`) |
| `--agent <label>` | Subagent attribution label |
| `--session <id>` | Override the session id |
| `--project <name>` | Override the project |

### `log` options

| Flag | Description |
|------|-------------|
| `-p, --project <name>` | Filter by project |
| `-t, --tag <tag>` | Filter by tag |
| `--unread` | Only unread entries |
| `-l, --limit <n>` | Limit the number of entries |
| `--format <fmt>` | `ai` or `json` (default: `ai`) |

### `config` options

| Flag | Description |
|------|-------------|
| `--sound [spec]` | `synth:<preset>`, `bundled:<file>`, `custom:<path>` or `off` |
| `--sound-volume <n>` | 0 to 1 |
| `--notify <onoff>` | `on` or `off` |
| `--obsidian <onoff>` | `on` or `off` |
| `--obsidian-vault <path>` | Set the Obsidian vault override |
| `--list-sounds` | List every available sound, bundled and synth, then exit |

---

## Who calls `record`

You rarely do. The normal writer is the `question_answer` tool on the genesis-tools MCP server, which an agent calls right after answering something worth keeping. `tools claude mcp` starts that server, and the `question` skill tells the agent when to fire it.

`--a-file` exists because answers are often long and full of characters a shell would mangle. Scripts should prefer it over `--a`.

## Tags

`question` is an actual question. `directive` is an instruction you gave mid-session. `action` is something that was done. The distinction matters when reviewing: directives are what you asked for, and are the most useful filter when reconstructing why a session went the way it did.

## Notes

- The sound and notification settings fire when an entry is recorded, which turns the sink into a live signal that an agent answered something, not only an archive.
- With Obsidian enabled, entries can be written into your vault as well, using the configured template.
- Live feed for a dashboard rather than a terminal: the dev-dashboard exposes the same stream over SSE.
