# tools question

> **Capture and review the questions fired at agents mid-session, with their answers.**

A substantive answer given halfway through a long session is lost in scrollback within an hour. This is the sink that keeps it: a local store of question and answer pairs, written by an agent as it works and readable afterward.

---

## Commands

| Command | Description |
|---------|-------------|
| `record` (alias `answer`) | Record a question and answer pair. Used by the `question_answer` MCP tool and by scripts. |
| `log` | Show recorded pairs, oldest first, last N entries |
| `tail` (alias `answers`) | Live feed of pairs as they are recorded, with a backlog |
| `config` | Read or update the sink config: sound, notify, Obsidian template |

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
