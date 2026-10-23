---
paths:
  - "plugins/**"
  - ".claude-plugin/**"
---

# The genesis-tools plugin (skills, hooks, agents)

Loaded by Claude Code when you read, write or edit a file under `plugins/` or `.claude-plugin/`.

- **A runtime plugin file is standalone.** The harness copies `plugins/**` out of this checkout, so no runtime plugin file imports `@genesiscz/*` or `@app/*`; inline what it needs or import a sibling file. `bun scripts/ci/check-plugin-standalone.ts` fails CI on a violation. Plain `JSON` is allowed in `plugins/**`.
- **A change users should get bumps the version** in `plugins/genesis-tools/.claude-plugin/plugin.json` and in `.claude-plugin/marketplace.json`, which holds it twice (top level and the plugin entry).
- **The mods plugin (`plugins/genesis-tools-mods/`) hot-reloads in every running session** that has its folder in
  `CLAUDE_CODE_PLUGIN_DIRS` (the shell, or the `env` block of `~/.claude/settings.json`): Claude Code 2.1.296 watches
  that folder in each interactive session (`CLAUDE_CODE_PLUGIN_DIR_WATCH`, on by default in a terminal) and reloads
  the mods when a file is saved, so do not ask the user to run `/reload-plugins` after an edit. Proof that a save
  reached the sessions: new `"why":"start"` lines in `~/.genesis-tools/agents/mods-log/git.jsonl` within seconds,
  one per session (2026-10-23, 18:44). Each save reloads every session, a half-finished edit too: on 2026-10-23 a
  session drew four git rows for a moment, because `git-band.tsx` already read a setting that `settings.ts` did not
  have yet. Finish the files of one change before you save the one that depends on them.
- **Never start slow work from a mods `ui.render` hook.** The engine aborts a render's in-flight `$` calls when a newer
  render of the same view replaces it (`$.process.run(...) aborted`), and the band redraws every second while a live
  time shows. On 2026-10-23 the first `tools genesis-tools probe` ran from a render, was aborted, and the plugin kept
  "no link opens" for 30 minutes in every session. Start such work from `session.start` or a timer
  (`primeGenesisProbe`), let a render only read the result, and never remember a result that came from an abort.
- **Skills load live from this working tree** when the session's folder is the marketplace folder (this repo). Any other folder gets the version-keyed cache: `claude plugin update genesis-tools@genesis-tools` refreshes it, and `/reload-plugins` re-reads it in the middle of a session.
- **Codex runs this plugin too, hooks included**, from its own version-keyed cache (`~/.codex/plugins/cache/genesis-tools/genesis-tools/<version>/`, one per Codex home). An edit reaches Codex only after `codex plugin add genesis-tools@genesis-tools` in each home (`CODEX_HOME=<home> codex plugin add …`). A hook decides the harness from its payload, never from the environment (`hooks/harness.ts`).
- **A hook runs on every matching tool call.** Keep it to one `bun` start (about 35 ms) and exit early when it has nothing to say. A PostToolUse payload from a subagent carries `agent_id`; key per-agent state on it.
- **Sessions lock the linked worktrees they use; never remove a locked worktree.** `hooks/worktree-lock.ts` runs `git worktree lock` when a session starts in a linked worktree, edits a file in one, or names one in a Bash command, with the reason `<harness> session <id> pid <agent pid> since <ISO time>`, and unlocks at SessionEnd. Claude Code, Codex and Grok all run it through this plugin. The tool-call part runs inside `area-rules.ts`, so it adds no `bun` start, and a command that names no worktree path spawns nothing. Never get past a lock with `git worktree remove -f -f` or `git worktree unlock`. Before you force anything, run `bun plugins/genesis-tools/hooks/worktree-lock.ts stale <repo>` (the exported `findStaleWorktreeLocks`): only a lock it lists is stale, because its pid is dead or was reused, and `stale <repo> --clear` unlocks exactly those. To remove a worktree that your OWN session locked, before the session ends: `bun plugins/genesis-tools/hooks/worktree-lock.ts release <worktree> --session <your session id>` (unlock plus a plain `git worktree remove` in one process, the lock restored when git refuses; another session's lock is never touched).
