# Debugging Master

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **LLM debugging toolkit — instrumentation primitives plus a token-efficient log reader.**

Tools for adding targeted instrumentation to a running app, capturing high-fidelity logs, and then reading those logs back in a format that keeps LLM context small. Paired with the `genesis-tools:debugging-master` skill.

---

## Subcommands

| Command | Description |
|---------|-------------|
| `start` | Start a new debug session with a named tag and optional filter |
| `get` | Retrieve recorded entries (with AI-friendly formatting) |
| `expand` | Expand a truncated entry to full content |
| `snippet` | Emit a copy-pasteable snippet of relevant code context |
| `sessions` | List active / recent sessions |
| `tail` | Live-tail a session |
| `cleanup` | Remove old sessions |
| `diff` | Compare two sessions to surface behavioural deltas |

Run any subcommand with `--help` for options.

---

## Global Options

| Option | Description |
|--------|-------------|
| `--session <name>` | Session name (fuzzy-matched) |
| `--format <type>` | Output format: `ai` (default), `json`, `md` |
| `--pretty` | Enhanced human-readable output (colors, box drawing) |
| `-v, --verbose` | Verbose logging |

---

## Typical Workflow

```bash
# 1. Start a session
tools debugging-master start --session "race-in-auth"

# 2. Run your app with the instrumentation hooks wired in (driven by the skill)

# 3. Read the last few interesting entries in AI-friendly form
tools debugging-master get --session race --format ai

# 4. Expand something that got truncated
tools debugging-master expand --session race --entry <id>

# 5. Compare two sessions to isolate a regression
tools debugging-master diff --session race-a --against race-b
```

---

## Related

- `genesis-tools:debugging-master` skill — the conversation-driven entry point; this CLI is its data plane.
