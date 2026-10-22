# tools genesis-tools

Developer tools for GenesisTools itself: what failed, crashed or ran slow, and who ran it.

## Failure log

Every tool run through `runTool` (and the few entry points without commander, through `watchToolRun`) writes one
JSON line per failed run to `~/.genesis-tools/logs/<date>-failures.jsonl`
(`src/utils/cli/failures/`). Kinds:

| kind | when |
|---|---|
| `usage` | commander refused the command line: unknown option or command, missing argument, no subcommand |
| `error` | the action threw and `runTool` printed `ERROR: …` |
| `crash` | an uncaught exception or an unhandled rejection; `fatal: false` when another handler kept the process alive |
| `exit` | a non-zero exit with none of the above (the tool printed its own message) |
| `interrupt` | Ctrl-C or SIGTERM (130, 143), often a harness timeout; hidden unless `--interrupts` |

Each record carries the tool, the command path, the arguments with secrets masked, the exit code, the message, the
stack, the last 4 KB of stderr, the cwd, the pid, the run time, the app trace id when GenesisTools.app started it, the
checkout that ran it, and the caller: agent (Claude Code, Codex, Grok, Copilot, or a shell), session id and title,
model and effort (from the session's own transcript), project, branch and commit.

## Commands

```bash
tools genesis-tools logs failures [--since 24h] [--tool git] [--kind usage,error] [--model haiku] [--agent codex]
tools genesis-tools logs show <id>          # one failure in full, with the day-log lines of its pid
tools genesis-tools logs stats --by tool,command,model
tools genesis-tools logs usage              # refused command lines: where the help or an alias is missing
tools genesis-tools logs crashes            # crash records and macOS crash reports of GenesisTools processes
tools genesis-tools logs day --level warn --tool ai --since 2h   # the pino day log, through rg
tools genesis-tools logs profile --min-ms 5000 --scope cli       # slow timers (tools config profiling)
tools genesis-tools logs paths
```

Every listing takes `--json`. `--since` reads `30m`, `24h`, `7d`, `HH:MM` or `YYYY-MM-DD`.
