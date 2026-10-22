/**
 * The files under src/utils that still name a `tools …` command, counted 2026-10-22 when lint-rules
 * `no-tool-command-in-utils` was added: 124 literals in 52 files, of which json2md, the notification `say` option
 * and the transclude grammar, recheck line and `cmd` allow-list were migrated at once. A ratchet: no file may join
 * this list, and a file leaves it as soon as its hints come from src/utils/genesis-tools/tools/hints.ts through its
 * GenesisTools caller. `lint-rules.test.ts` fails when a listed file no longer names a command, so the list cannot
 * go stale.
 *
 * notifications-app.ts is GenesisTools-only by design (notifications.ts loads it by a runtime path, and a copy
 * leaves it out), so its hints stay where they are.
 */
export const TOOL_COMMAND_RATCHET: ReadonlySet<string> = new Set<string>([
    "src/utils/agent-sessions/history-cli.ts",
    "src/utils/agent-sessions/open-service.ts",
    "src/utils/ai/AIAccount.ts",
    "src/utils/ai/config/account-ops.ts",
    "src/utils/ai/config/doctor.ts",
    "src/utils/ai/core/resolve.ts",
    "src/utils/ai/evaluation/auth.ts",
    "src/utils/ai/evaluation/cli.ts",
    "src/utils/ai/evaluation/config-cli.ts",
    "src/utils/ai/evaluation/errors.ts",
    "src/utils/ai/evaluation/service.ts",
    "src/utils/ai/gate/request.ts",
    "src/utils/ai/github-copilot/auth-errors.ts",
    "src/utils/ai/grok/account.ts",
    "src/utils/ai/grok/stored-grant.ts",
    "src/utils/ai/local/runtimes/transformers-js/index.ts",
    "src/utils/ai/openai/account-binding.ts",
    "src/utils/ai/providers/credentials.ts",
    "src/utils/ai/providers/elevenlabs/AIElevenLabsTextToSpeechProvider.ts",
    "src/utils/ai/providers/plugins/anthropic-sub/subscription.ts",
    "src/utils/ai/providers/plugins/anthropic-sub/warmup.ts",
    "src/utils/ai/providers/plugins/huggingface.ts",
    "src/utils/ai/providers/plugins/openai-sub/usage.ts",
    "src/utils/ai/providers/resolve.ts",
    "src/utils/ai/statusline/config.ts",
    "src/utils/ai/stt/resolve.ts",
    "src/utils/ai/tasks/resolve-task.ts",
    "src/utils/ai/warmup/index.ts",
    "src/utils/browser-router/presets.ts",
    "src/utils/browser-router/router-link.ts",
    "src/utils/claude/subscription-auth.ts",
    "src/utils/cmux/lib/health.ts",
    "src/utils/cmux/tmux-host.ts",
    "src/utils/DashboardApp/lifecycle.ts",
    "src/utils/git/base-detect.ts",
    "src/utils/ink/usage-dashboard/views/overview-view.tsx",
    "src/utils/macos/apple-calendar.ts",
    "src/utils/macos/full-disk-access.ts",
    "src/utils/macos/notifications-app.ts",
    "src/utils/macos/xcode.ts",
    "src/utils/search/stores/sqlite-vector-store.ts",
    "src/utils/security/MasterKey.ts",
    "src/utils/security/SecretStore.ts",
    "src/utils/security/vault-admin.ts",
    "src/utils/ts/sourcemaps/find-commit.ts",
    "src/utils/ui/dashboards.ts",
    "src/utils/worker/contract.ts",
]);
