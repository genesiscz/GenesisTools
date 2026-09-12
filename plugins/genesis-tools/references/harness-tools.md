# Harness tool equivalents

This plugin is installed **verbatim** by Claude Code, Codex and Grok. Every skill, command and
agent file in it is read by all three, so a document that names a Claude tool without saying so
is telling two of three harnesses to use something they do not have.

**Point at this table instead of restating tool names in each document.** The names below are
not guesses: each was read out of real session transcripts on this machine (2026-09-11), with
the observed call count where it is interesting.

| Capability | Claude Code | Codex | Grok |
|---|---|---|---|
| Spawn a subagent | `Agent` (`subagent_type`, `model`) | `spawn_agent` | `spawn_subagent` |
| Message / requeue a running agent | `SendMessage` | `send_message`, `followup_task` | (spawn a new one) |
| Read a background command's output | `Monitor`, `BashOutput` | `wait`, `wait_agent` | `get_command_or_subagent_output` (1520 calls) |
| Stop a background command or agent | `TaskStop` | `wait_agent` then end the turn | `kill_command_or_subagent` |
| Ask the user a structured question | `AskUserQuestion` | `request_user_input_async` | `ask_user_question` |
| Run a shell command | `Bash` (`run_in_background`) | `exec` | `run_terminal_command` |
| Read a file | `Read` | `exec` (`cat`/`sed`) | `read_file` |
| Targeted edit | `Edit`, `MultiEdit` | `exec` running `apply_patch` | `search_replace` (10189 calls) |
| Create / overwrite a file | `Write` | `exec` running `apply_patch` | `write` |
| Invoke a plugin command | `Skill` | its own command invocation | its own command invocation |
| Plugin source | `~/.claude/plugins/cache/<v>` | `~/.codex/plugins/cache/<v>` per `CODEX_HOME` | LIVE from the repo path |

## Things that are easy to get wrong

- 🛑 **Grok has subagents.** `--agents`, `--no-subagents`, an Agent Dashboard, and
  `spawn_subagent` in the transcripts. "Grok has no subagents, do it inline" is false.
- 🛑 **All three can ask the user a structured question.** "Ask in plain text on the others" is
  false; only the tool NAME differs.
- ⚠️ **No harness but Claude has a push subscription.** Codex `wait` and Grok
  `get_command_or_subagent_output` are POLLS: you ask, you get what has accumulated. A protocol
  that needs to be woken (see `skills/agents-talk`) genuinely cannot be built on them; a
  protocol that just needs to observe a stream can.
- ⚠️ **Codex has no file-edit tool.** Its edits arrive as a `FileChange` item produced by
  `exec`; there is no `apply_patch` **tool name** in a hook payload. That is why a PostToolUse
  matcher naming Claude's edit tools never fires there
  (`hooks/track-session-files.ts` explains the consequence).
- ⚠️ **A Claude model id is not portable.** `haiku`, `sonnet`, `opus`, `fable` mean nothing to
  the other two; say "a cheap model" and let the harness pick.
- ⚠️ **`${CLAUDE_PLUGIN_ROOT}` substitution outside Claude is UNVERIFIED.** A hook that runs
  proves the command resolved, which happens both when the harness templates the placeholder
  and when it merely exports the variable for a shell to expand. Under the second, a markdown
  body keeps the literal text and a **Read** of that path fails. So every "read this path"
  instruction in this plugin also names a repo-relative fallback.
