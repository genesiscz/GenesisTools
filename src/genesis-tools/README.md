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

A run the default signal action kills never reaches its own watcher. Its waiting parent writes that record instead:
the GenesisTools.app launcher (`src/macos/GenesisTools/Sources/Host/LauncherFailures.swift`) on the default path, or
the `tools` wrapper when it spawned a plain bun child (`src/utils/cli/failures/launcher.ts`). The kind is `interrupt`
for SIGINT, SIGTERM, SIGHUP, SIGQUIT and SIGKILL, and `crash` for a fault signal (SIGSEGV, SIGBUS, SIGILL, SIGFPE,
SIGABRT, SIGTRAP). Neither parent has the command definition, so the arguments read `[withheld]` and the command is
empty; the launcher's record has no caller. Both use the run id in `GENESIS_TOOLS_RUN_ID`, so one run gets one record.
A run exec'd straight into bun (`GENESIS_TOOLS_NO_APP=1`, Linux) has no waiting parent and stays unrecorded.

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
tools genesis-tools probe                   # what of GenesisTools this Mac has, and which links a click opens
tools genesis-tools probe md finder         # exit 1, with the fix command, when one of them is missing
tools genesis-tools probe --url <url>       # whether a click on this one link opens what it names
tools genesis-tools probe --json            # the same for code (the mods plugin reads it)
```

`probe` (`src/utils/genesis-tools/probe.ts`) checks the parts (`tools`, `app`, `router`, `markdown`, `cmux`) and
each link kind (`md`, `finder`, `hub`, `claude-find`). A kind opens when GenesisTools.app is installed, it is the
https handler, the router config routes that path (by `route()`, so a hand-made route counts), and the app or
command the route names is there. It reads only. `.claude/rules/genesis-links.md` says where links are built.

Every listing takes `--json`. `--since` reads `30m`, `24h`, `7d`, `HH:MM` or `YYYY-MM-DD`.
