=== a23a57d: fix(rename-commits): use explicit radix in parseInt ===
src/rename-commits/index.ts

=== d34b0e4: fix(github-pr): add pagination for threads with >50 comments ===
src/github-pr/index.ts

=== 4ec06d5: chore(tools): replace relative imports with @app/ path aliases ===
src/azure-devops/index.ts
src/cursor-context/index.ts
src/mcp-manager/commands/__tests__/backup.test.ts
src/mcp-manager/commands/__tests__/config.test.ts
src/mcp-manager/commands/__tests__/install.test.ts
src/mcp-manager/commands/__tests__/list.test.ts
src/mcp-manager/commands/__tests__/rename.test.ts
src/mcp-manager/commands/__tests__/show.test.ts
src/mcp-manager/commands/__tests__/sync-from-providers.test.ts
src/mcp-manager/commands/__tests__/sync.test.ts
src/mcp-manager/commands/__tests__/test-utils.ts
src/mcp-manager/commands/__tests__/toggle-server.test.ts
src/mcp-manager/commands/backup.ts
src/mcp-manager/commands/config-json.ts
src/mcp-manager/commands/config.ts
src/mcp-manager/commands/disable.ts
src/mcp-manager/commands/enable.ts
src/mcp-manager/commands/install.ts
src/mcp-manager/commands/list.ts
src/mcp-manager/commands/rename.ts
src/mcp-manager/commands/show.ts
src/mcp-manager/commands/sync-from-providers.ts
src/mcp-manager/commands/sync.ts
src/mcp-manager/commands/toggle-server.ts
src/mcp-manager/utils/providers/claude.ts
src/mcp-manager/utils/providers/codex.ts
src/mcp-manager/utils/providers/cursor.ts
src/mcp-manager/utils/providers/gemini.ts
src/mcp-manager/utils/providers/types.ts
src/rename-commits/index.ts
src/timely/api/client.ts
src/timely/api/service.ts
src/timely/commands/accounts.ts
src/timely/commands/events.ts
src/timely/commands/export-month.ts
src/timely/commands/login.ts
src/timely/commands/logout.ts
src/timely/commands/projects.ts
src/timely/commands/status.ts
src/timely/utils/entry-processor.ts
src/usage/index.ts

=== 58d68e6: chore: configure TypeScript for dashboard and add typecheck script ===
package.json
src/claude-history-dashboard/tsconfig.json
tsconfig.json

=== 5c1ca05: fix: resolve TypeScript errors across multiple tools ===
src/Internal/LoggerLib/Logger.ts
src/git-commit/index.ts
src/github-release-notes/index.ts
src/macos-resources/Table.tsx
src/utils/storage/index.ts

=== e90b1dd: fix(mcp-manager): fix test spyOn syntax and global enablement logic ===
src/mcp-manager/commands/__tests__/backup.test.ts
src/mcp-manager/commands/toggle-server.ts

=== f877acf: refactor(claude-history): clean up dashboard and fix cross-platform paths ===
src/claude-history-dashboard/README.md
src/claude-history-dashboard/public/logo192.png
src/claude-history-dashboard/public/logo512.png
src/claude-history-dashboard/public/manifest.json
src/claude-history-dashboard/public/tanstack-word-logo-white.svg
src/claude-history/dashboard.tsx
src/claude-history/lib.ts

=== 20a07f9: fix(github-pr): remove unused --comment-id option ===
src/github-pr/index.ts

=== f19a2db: fix(mcp-manager): backup and restore state on WriteResult.Rejected ===
src/mcp-manager/commands/toggle-server.ts

=== cc36e71: fix(npm-package-diff): handle zero-byte sizes and fix config merging ===
src/npm-package-diff/index.ts

=== 6eed888: fix(rename-commits): add validation to prevent empty commit messages ===
src/rename-commits/index.ts

=== c31d098: feat(mcp-manager): add WriteResult enum for richer write status ===
src/mcp-manager/commands/__tests__/test-utils.ts
src/mcp-manager/commands/install.ts
src/mcp-manager/commands/rename.ts
src/mcp-manager/commands/sync.ts
src/mcp-manager/commands/toggle-server.ts
src/mcp-manager/utils/providers/claude.ts
src/mcp-manager/utils/providers/codex.ts
src/mcp-manager/utils/providers/cursor.ts
src/mcp-manager/utils/providers/gemini.ts
src/mcp-manager/utils/providers/types.ts

=== e62e037: chore(dashboard): regenerate route tree after removing demo routes ===
src/claude-history-dashboard/src/routeTree.gen.ts

=== 49d43ea: fix(json): simplify stdin reading with Bun.stdin.text() ===
src/json/index.ts

=== 285d460: fix: address code review feedback from PR #2 ===
src/claude-history-dashboard/src/routes/__root.tsx
src/claude-history/index.ts
src/claude-history/lib.ts
src/claude-history/types.ts
src/github-pr/index.ts
src/mcp-manager/commands/install.ts
src/mcp-manager/utils/command.utils.ts
src/npm-package-diff/index.ts

=== b55a8bd: fix(claude-history): Use Node.js stat instead of Bun.file().stat() ===
src/claude-history/lib.ts

=== de0f5ef: chore(dashboard): Remove demo routes and data ===
src/claude-history-dashboard/src/data/demo.punk-songs.ts
src/claude-history-dashboard/src/routes/demo/api.names.ts
src/claude-history-dashboard/src/routes/demo/api.tq-todos.ts
src/claude-history-dashboard/src/routes/demo/start.api-request.tsx
src/claude-history-dashboard/src/routes/demo/start.server-funcs.tsx
src/claude-history-dashboard/src/routes/demo/start.ssr.data-only.tsx
src/claude-history-dashboard/src/routes/demo/start.ssr.full-ssr.tsx
src/claude-history-dashboard/src/routes/demo/start.ssr.index.tsx
src/claude-history-dashboard/src/routes/demo/start.ssr.spa-mode.tsx
src/claude-history-dashboard/src/routes/demo/tanstack-query.tsx

=== c63e7b3: chore(dashboard): Remove unused boilerplate files ===
src/claude-history-dashboard/src/App.test.tsx
src/claude-history-dashboard/src/App.tsx
src/claude-history-dashboard/src/logo.svg

=== a728b2e: fix(dashboard): Use generated routeTree and add devtools production check ===
src/claude-history-dashboard/src/main.tsx
src/claude-history-dashboard/src/routes/__root.tsx

=== 4e42089: chore: Remove dead code and fix documentation ===
CLAUDE.md
Useful.md
src/claude-history/index.ts
src/collect-files-for-ai/index.ts
src/jenkins-mcp/index.ts
src/last-changes/index.ts

=== 708d504: fix(github-pr): Improve diff hunk context and suggestion formatting ===
src/github-pr/index.ts

=== 09b7f1f: fix(dashboard): Fix accessibility and type issues ===
src/claude-history-dashboard/src/components/ui/command.tsx
src/claude-history-dashboard/src/main.tsx
src/claude-history-dashboard/src/reportWebVitals.ts

=== e495351: refactor(rename-commits): Use isPromptCancelled helper ===
src/rename-commits/index.ts

=== 543484e: fix: Improve type safety and prevent ReDoS vulnerability ===
src/claude-history/lib.ts
src/claude-history/types.ts
src/logger.ts
src/mcp-manager/utils/command.utils.ts

=== 2886895: feat(mcp-manager): Add automatic backup before writing config files ===
src/mcp-manager/utils/config.utils.ts
src/mcp-manager/utils/providers/claude.ts
src/mcp-manager/utils/providers/codex.ts
src/mcp-manager/utils/providers/cursor.ts
src/mcp-manager/utils/providers/gemini.ts
src/mcp-manager/utils/providers/types.ts

=== a6589d3: fix(mcp-manager): Fix --provider flag filtering and config handling ===
src/mcp-manager/commands/install.ts
src/mcp-manager/commands/rename.ts
src/mcp-manager/commands/sync-from-providers.ts
src/mcp-manager/commands/sync.ts
src/mcp-manager/commands/toggle-server.ts

=== 14d85a9: feat(plugin): Add claude-history command and session tracking hooks ===
plugins/genesis-tools/commands/claude-history.md
plugins/genesis-tools/hooks/hooks.json
plugins/genesis-tools/hooks/track-session-files.ts

=== d866674: chore(plugin): Add genesis-tools prefix to skill/command names ===
plugins/genesis-tools/.claude-plugin/plugin.json
plugins/genesis-tools/commands/github-pr.md
plugins/genesis-tools/commands/setup.md
plugins/genesis-tools/skills/azure-devops/SKILL.md
plugins/genesis-tools/skills/claude-history/SKILL.md

=== 34ae82b: refactor(deps): Remove enquirer, migrate to @inquirer/prompts ===
bun.lock
index.ts
package.json
src/mcp-manager/commands/__tests__/TESTING_GUIDE.md
tools

=== 32ab119: feat(claude-history): Add session ID, relevance scoring, and advanced filters ===
src/claude-history/index.ts
src/claude-history/lib.ts
src/claude-history/types.ts

=== 6243179: fix(plugin): Fix marketplace paths for commands/skills ===
.claude-plugin/marketplace.json

=== 290bb3c: fix(mcp-manager): Migrate tests from enquirer to @inquirer/prompts ===
src/mcp-manager/commands/__tests__/enquirer-mock.ts
src/mcp-manager/commands/__tests__/inquirer-mock.ts
src/mcp-manager/commands/__tests__/install.test.ts
src/mcp-manager/commands/__tests__/rename.test.ts
src/mcp-manager/commands/__tests__/sync-from-providers.test.ts
src/mcp-manager/commands/__tests__/sync.test.ts

=== 9b3ccaf: docs(ai): Update agent guidance for enquirer→@inquirer/prompts migration ===
.claude/docs/testing.md
CLAUDE.md
Useful.md
src/ask/Plan.md
src/json/README.md
src/mcp-manager/README.md
src/timely/Plan.md
src/timely/Plan2.md

=== 4402372: feat(github-pr): Add github-pr command + claude plugin ===
.claude/commands/github-pr.md
plugins/genesis-tools/.claude-plugin/plugin.json
plugins/genesis-tools/commands/github-pr.md
src/github-pr/index.ts

=== 7fa92b0: doc(readme): Add deepwiki ===
README.md

=== 5812ce2: fix(claude-plugin): Fix marketplace ===
.claude-plugin/marketplace.json

=== ff03236: feat(claude-history-dashboard): pages ===
src/claude-history-dashboard/bun.lock
src/claude-history-dashboard/package.json
src/claude-history-dashboard/src/components/Header.tsx
src/claude-history-dashboard/src/components/ui/badge.tsx
src/claude-history-dashboard/src/components/ui/button.tsx
src/claude-history-dashboard/src/components/ui/card.tsx
src/claude-history-dashboard/src/components/ui/command.tsx
src/claude-history-dashboard/src/components/ui/dialog.tsx
src/claude-history-dashboard/src/components/ui/input.tsx
src/claude-history-dashboard/src/components/ui/scroll-area.tsx
src/claude-history-dashboard/src/components/ui/table.tsx
src/claude-history-dashboard/src/cyberpunk.css
src/claude-history-dashboard/src/routeTree.gen.ts
src/claude-history-dashboard/src/routes/__root.tsx
src/claude-history-dashboard/src/routes/conversation.$id.tsx
src/claude-history-dashboard/src/routes/index.tsx
src/claude-history-dashboard/src/routes/stats.tsx
src/claude-history-dashboard/src/server/conversations.ts
src/claude-history-dashboard/src/styles.css
src/claude-history-dashboard/tsconfig.json
src/claude-history/index.ts

=== 5176d1b: feat(claude-history-dashboard): tanstack start ===
src/claude-history-dashboard/.cta.json
src/claude-history-dashboard/.cursorrules
src/claude-history-dashboard/.gitignore
src/claude-history-dashboard/.vscode/settings.json
src/claude-history-dashboard/README.md
src/claude-history-dashboard/biome.json
src/claude-history-dashboard/bun.lock
src/claude-history-dashboard/components.json
src/claude-history-dashboard/package.json
src/claude-history-dashboard/src/components/Header.tsx
src/claude-history-dashboard/src/data/demo.punk-songs.ts
src/claude-history-dashboard/src/integrations/tanstack-query/devtools.tsx
src/claude-history-dashboard/src/integrations/tanstack-query/root-provider.tsx
src/claude-history-dashboard/src/lib/utils.ts
src/claude-history-dashboard/src/router.tsx
src/claude-history-dashboard/src/routes/__root.tsx
src/claude-history-dashboard/src/routes/demo/api.names.ts
src/claude-history-dashboard/src/routes/demo/api.tq-todos.ts
src/claude-history-dashboard/src/routes/demo/start.api-request.tsx
src/claude-history-dashboard/src/routes/demo/start.server-funcs.tsx
src/claude-history-dashboard/src/routes/demo/start.ssr.data-only.tsx
src/claude-history-dashboard/src/routes/demo/start.ssr.full-ssr.tsx
src/claude-history-dashboard/src/routes/demo/start.ssr.index.tsx
src/claude-history-dashboard/src/routes/demo/start.ssr.spa-mode.tsx
src/claude-history-dashboard/src/routes/demo/tanstack-query.tsx
src/claude-history-dashboard/src/routes/index.tsx
src/claude-history-dashboard/tsconfig.json
src/claude-history-dashboard/vite.config.ts

=== d1895f7: feat(claude-history-dashboard): styles ===
src/claude-history-dashboard/src/styles.css

=== 9de3ae6: feat(claude-history-dashboard): Simple dashboard ===
src/claude-history/dashboard.tsx
src/claude-history/index.ts
src/claude-history/lib.ts

=== 44e86be: feat(claude-history-dashboard): Init claude-history ===
src/claude-history-dashboard/.cta.json
src/claude-history-dashboard/.gitignore
src/claude-history-dashboard/.vscode/settings.json
src/claude-history-dashboard/README.md
src/claude-history-dashboard/bun.lock
src/claude-history-dashboard/index.html
src/claude-history-dashboard/package.json
src/claude-history-dashboard/public/favicon.ico
src/claude-history-dashboard/public/logo192.png
src/claude-history-dashboard/public/logo512.png
src/claude-history-dashboard/public/manifest.json
src/claude-history-dashboard/public/robots.txt
src/claude-history-dashboard/public/tanstack-circle-logo.png
src/claude-history-dashboard/public/tanstack-word-logo-white.svg
src/claude-history-dashboard/src/App.test.tsx
src/claude-history-dashboard/src/App.tsx
src/claude-history-dashboard/src/components/Header.tsx
src/claude-history-dashboard/src/logo.svg
src/claude-history-dashboard/src/main.tsx
src/claude-history-dashboard/src/reportWebVitals.ts
src/claude-history-dashboard/src/styles.css
src/claude-history-dashboard/tsconfig.json
src/claude-history-dashboard/vite.config.ts

=== af3125b: feat(raycast): kill port fix ===
raycast/kill-port/kill-port.sh

=== c768351: feat(mcp-manager): help command ===
src/mcp-manager/index.ts

=== ee0a8d7: feat(claude-history): Tool + Skill ===
plugins/genesis-tools/skills/claude-history/SKILL.md
plugins/genesis-tools/skills/claude-history/references/schema.md
src/claude-history/index.ts
src/claude-history/types.ts

=== bfd5e6e: feat(raycast): kill-port.sh ===
raycast/kill-port/kill-port.sh

=== 225a8d8: feat(jenkins-mcp): new mcp command ===
bun.lock
package.json
src/jenkins-mcp/index.ts

=== 6667a2b: feat(tools): Help for all commands ===
src/timely/index.ts

=== 0c49acc: feat(mcp-manager): Enable 'help <command>' subcommand ===
src/mcp-manager/index.ts

=== 75929c6: fix(git-last-commits-diff): Fix invalid Commander short flag -cl ===
src/git-last-commits-diff/index.ts

=== da34021: ref(tools): Uninstall enquirer and minimist ===
bun.lock
package.json

=== e3249a6: ref(tools): Migrate remaining files from Enquirer/minimist ===
src/fsevents-profile/index.ts
src/github-release-notes/index.ts
src/hold-ai/server.ts
src/logger.ts
src/mcp-debug/index.ts
src/mcp-web-reader/index.ts
src/timely/api/client.ts
src/watch/index.ts

=== 4586482: ref(macos-eslogger): Migrate to @inquirer/prompts + Commander ===
src/macos-eslogger/index.ts

=== 3d9ca36: ref(git-last-commits-diff): Migrate to @inquirer/prompts + Commander ===
src/git-last-commits-diff/index.ts

=== 56bde97: ref(timely): Migrate to @inquirer/prompts + Commander with subcommands ===
src/timely/commands/accounts.ts
src/timely/commands/cache.ts
src/timely/commands/events.ts
src/timely/commands/export-month.ts
src/timely/commands/login.ts
src/timely/commands/logout.ts
src/timely/commands/projects.ts
src/timely/commands/status.ts
src/timely/index.ts

=== ae45f71: ref(mcp-manager): Migrate to @inquirer/prompts + Commander ===
src/mcp-manager/commands/install.ts
src/mcp-manager/commands/rename.ts
src/mcp-manager/commands/sync-from-providers.ts
src/mcp-manager/commands/sync.ts
src/mcp-manager/index.ts

=== 2851863: ref(cursor-context): Migrate to @inquirer/prompts + Commander ===
src/cursor-context/index.ts

=== eafcc58: ref(npm-package-diff): Migrate to Commander ===
src/npm-package-diff/index.ts

=== 69a9627: ref(ask): Migrate to @inquirer/prompts + Commander ===
src/ask/chat/CommandHandler.ts
src/ask/index.ts
src/ask/providers/ModelSelector.ts
src/ask/utils/cli.ts

=== 946e8fa: ref(watchman): Migrate to @inquirer/prompts + Commander ===
src/watchman/index.ts

=== cfbbef1: ref(rename-commits): Migrate to @inquirer/prompts + Commander ===
src/rename-commits/index.ts

=== 4cd30f6: ref(files-to-prompt): Migrate to Commander ===
src/files-to-prompt/index.ts

=== 121de09: ref(git-commit): Migrate to @inquirer/prompts + Commander ===
src/git-commit/index.ts

=== ef320f6: ref(watch): Migrate to Commander ===
src/watch/index.ts

=== f449c2b: ref(git-rebase-multiple): Migrate to Commander ===
src/git-rebase-multiple/index.ts

=== 89d1dd3: ref(mcp-tsc): Migrate to Commander ===
src/mcp-tsc/cli/CliHandler.ts

=== 92fc061: ref(collect-files-for-ai): Migrate to Commander ===
src/collect-files-for-ai/index.ts

=== 6e699b2: ref(json): Migrate to Commander ===
src/json/index.ts

=== fb72d00: ref(last-changes): Migrate to Commander ===
src/last-changes/index.ts

=== 4562b98: ref(fsevents-profile): Migrate to Commander ===
src/fsevents-profile/index.ts

=== c0257cd: ref(usage): Migrate to Commander ===
src/usage/index.ts

=== 00be82f: ref(tools): Migrate shared utilities to @inquirer/prompts ===
bun.lock
package.json
src/git-rebase-multiple/prompts.ts
src/mcp-manager/utils/backup.ts
src/mcp-manager/utils/command.utils.ts
src/utils/prompt-helpers.ts

=== 7fc9203: feat(mcp-manager): config-json command + better handling of env & headers ===
src/mcp-manager/README.md
src/mcp-manager/commands/config-json.ts
src/mcp-manager/commands/index.ts
src/mcp-manager/commands/install.ts
src/mcp-manager/index.ts
src/mcp-manager/utils/command.utils.ts

=== 2d4644c: feat(git-rebase-multiple): New command to rebase multiple branches at once ===
README.md
src/git-rebase-multiple/README.md
src/git-rebase-multiple/backup.ts
src/git-rebase-multiple/forkpoint.ts
src/git-rebase-multiple/git.ts
src/git-rebase-multiple/index.ts
src/git-rebase-multiple/prompts.ts
src/git-rebase-multiple/state.ts
src/git-rebase-multiple/types.ts

=== e964a92: feat(mcp-manager): Refactor, enhance installation/sync/backuping/writing ===
src/mcp-manager/commands/__tests__/test-utils.ts
src/mcp-manager/commands/sync.ts
src/mcp-manager/index.ts
src/mcp-manager/utils/providers/claude.ts
src/mcp-manager/utils/providers/codex.ts
src/mcp-manager/utils/providers/cursor.ts
src/mcp-manager/utils/providers/gemini.ts
src/mcp-manager/utils/providers/types.ts

=== 219e979: docs(useful): Useful.md file ===
Useful.md

=== ddcb53a: feat(claude): Marketplace ===
README.md

=== 027ca9d: refactor(mcp-manager): safe config writing with preview-before-write ===
src/mcp-manager/commands/__tests__/install.test.ts
src/mcp-manager/commands/__tests__/rename.test.ts
src/mcp-manager/commands/__tests__/sync-from-providers.test.ts
src/mcp-manager/commands/__tests__/test-utils.ts
src/mcp-manager/commands/__tests__/toggle-server.test.ts
src/mcp-manager/commands/sync-from-providers.ts
src/mcp-manager/commands/sync.ts
src/mcp-manager/commands/toggle-server.ts
src/mcp-manager/utils/config.utils.ts
src/mcp-manager/utils/providers/claude.ts
src/mcp-manager/utils/providers/codex.ts
src/mcp-manager/utils/providers/cursor.ts
src/mcp-manager/utils/providers/gemini.ts
src/mcp-manager/utils/providers/types.ts

=== b24aec8: feat(mcp-manager): add non-interactive mode support ===
src/mcp-manager/commands/__tests__/config.test.ts
src/mcp-manager/commands/__tests__/test-utils.ts
src/mcp-manager/commands/config.ts
src/mcp-manager/commands/disable.ts
src/mcp-manager/commands/enable.ts
src/mcp-manager/commands/install.ts
src/mcp-manager/commands/sync-from-providers.ts
src/mcp-manager/commands/sync.ts
src/mcp-manager/commands/toggle-server.ts
src/mcp-manager/index.ts
src/mcp-manager/utils/backup.ts
src/mcp-manager/utils/command.utils.ts
src/mcp-manager/utils/config.utils.ts
src/mcp-manager/utils/providers/claude.ts
src/mcp-manager/utils/providers/codex.ts
src/mcp-manager/utils/providers/cursor.ts
src/mcp-manager/utils/providers/gemini.ts
src/mcp-manager/utils/providers/types.ts

