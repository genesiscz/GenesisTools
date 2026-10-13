---
paths:
  - "plugins/**"
  - ".claude-plugin/**"
---

# The genesis-tools plugin (skills, hooks, agents)

Loaded by Claude Code when you read, write or edit a file under `plugins/` or `.claude-plugin/`.

- **A runtime plugin file is standalone.** The harness copies `plugins/**` out of this checkout, so no runtime plugin file imports `@genesiscz/*` or `@app/*`; inline what it needs or import a sibling file. `bun scripts/ci/check-plugin-standalone.ts` fails CI on a violation. Plain `JSON` is allowed in `plugins/**`.
- **A change users should get bumps the version** in `plugins/genesis-tools/.claude-plugin/plugin.json` and in `.claude-plugin/marketplace.json`, which holds it twice (top level and the plugin entry).
- **Skills load live from this working tree** when the session's folder is the marketplace folder (this repo). Any other folder gets the version-keyed cache: `claude plugin update genesis-tools@genesis-tools` refreshes it, and `/reload-plugins` re-reads it in the middle of a session.
- **Codex runs this plugin too, hooks included**, from its own version-keyed cache (`~/.codex/plugins/cache/genesis-tools/genesis-tools/<version>/`, one per Codex home). An edit reaches Codex only after `codex plugin add genesis-tools@genesis-tools` in each home (`CODEX_HOME=<home> codex plugin add …`). A hook decides the harness from its payload, never from the environment (`hooks/harness.ts`).
- **A hook runs on every matching tool call.** Keep it to one `bun` start (about 35 ms) and exit early when it has nothing to say. A PostToolUse payload from a subagent carries `agent_id`; key per-agent state on it.
- **Sessions lock the linked worktrees they use; never remove a locked worktree.** `hooks/worktree-lock.ts` runs `git worktree lock` when a session starts in a linked worktree, edits a file in one, or names one in a Bash command, with the reason `<harness> session <id> pid <agent pid> since <ISO time>`, and unlocks at SessionEnd. Claude Code, Codex and Grok all run it through this plugin. The tool-call part runs inside `area-rules.ts`, so it adds no `bun` start, and a command that names no worktree path spawns nothing. Never get past a lock with `git worktree remove -f -f` or `git worktree unlock`. Before you force anything, run `bun plugins/genesis-tools/hooks/worktree-lock.ts stale <repo>` (the exported `findStaleWorktreeLocks`): only a lock it lists is stale, because its pid is dead or was reused, and `stale <repo> --clear` unlocks exactly those.
