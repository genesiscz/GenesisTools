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
- ⚠️ **Codex edits are `exec` in the transcript and `apply_patch` on the hook.** A session on
  2026-09-29 still records the call as `name: exec` whose input is an apply_patch. Codex 0.155
  reports `tool_name: apply_patch` to the hook, and `Edit` or `Write` match that call. The
  Claude-shaped matcher in `hooks/track-session-files.ts` does fire: two Codex sessions pinned
  that day left tracked files. The older note that the matcher never fires is not true of 0.155.
- ⚠️ **A Claude model id is not portable.** `haiku`, `sonnet`, `opus`, `fable` mean nothing to
  the other two; say "a cheap model" and let the harness pick.
- ⚠️ **`${CLAUDE_PLUGIN_ROOT}` in a skill body is not a shell variable.** Claude substitutes it
  when the skill loads. If the document still shows the placeholder, build the path from the
  skill's base directory, and keep the repo-relative fallback. Hook commands are a separate
  case: unquoted `bun ${CLAUDE_PLUGIN_ROOT}/hooks/<script>.ts` ran on Grok 1.0.44 (2026-09-29),
  and Codex sessions that day wrote pins. A quoted path is a different failure: Grok joins the
  hooks directory in front of the quote.
