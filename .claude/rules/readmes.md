---
paths:
  - "src/*/README.md"
---

# Tool READMEs (src/<tool>/README.md)

Loaded by Claude Code when you read, write or edit a tool's README. Three readers depend on it: a person running
`tools <tool> --readme`, the docs site that renders every README from origin/master, and an agent deciding how to call
the tool. Write it for someone who has never seen the tool and has only this page.

## What every README has, in this order

1. `# tools <tool>`, then one or two sentences: what the tool does, for whom, and why someone would use it.
2. **Quick start**: three to six real commands, the most common first, each with a one-line comment.
3. **Commands**: every subcommand the tool registers, with its main flags and what it does in one line. A big tool
   groups them by job. Take them from `tools <tool> --help` and `tools <tool> <sub> --help`, never from memory.
4. **How it works**: where its data and config live (`~/.genesis-tools/<tool>/…`), what it calls (an API, another
   tool, GenesisTools.app, an MCP server), what it needs on the Mac (permissions, apps), and what costs money.
5. **Configuration**: config files with their keys and defaults, environment variables, accounts.
6. **For agents**, when it applies: `--json` output, exit codes, MCP tools, the node-repl toolset, the plugin skill.
7. **Troubleshooting**, when the tool has real failure modes: the symptom, the cause, the fix.
8. **Related**: the tools it works with, linked as `../<tool>/README.md`.

A small tool merges sections. A section with nothing true to say is left out, never filled with filler.

## Rules

- Every command, flag, default, path and environment variable is checked against `--help` or the source in the same
  change. A README that names a command or flag the tool does not have is a bug.
- Keep what the old README knew: gotchas, measured numbers, dated notes and decisions stay. Move them or shorten
  them, but never drop a fact silently.
- Examples use invented data: `alice@example.com`, `owner/repo#42`, `~/Projects/app`. No real names, accounts,
  client names, private repositories, or paths with a user name. `bash scripts/ci/placeholder-check.sh` must pass.
- Plain English, short sentences, active voice. No em or en dashes, no marketing words.
- Commands go in fenced blocks. A long command keeps one flag per line with `\` continuations.
- Use a table only where it helps (a flag list), and keep it narrow: `--readme` prints it in a terminal.
- Deep material (a design, a file format, a long recipe) goes in a `docs/` file beside the README, linked from it.
