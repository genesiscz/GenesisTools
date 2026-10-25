/*
 * The job that empties this list: handoff h_2ehgo4gz, "lint-ratchets-migration" (genesis-tools MCP handoff_get
 * { name: "lint-ratchets-migration" }). Remove a file here in the same commit that migrates it.
 */
/**
 * The files that still build a path into a coding agent's own home by hand, counted 2026-10-25 when lint-rules
 * `no-hand-built-claude-home` and `no-hand-built-codex-grok-home` were added (❓ DECISION 22 b, a Haiku survey,
 * NativeHomes, in the notes of 2026-10-25). Ratchets: no file may join a list, and a file
 * leaves it once it asks `nativeHome(kind)` or `nativeSessionRoots(kind)` (src/utils/providers/session-paths.ts).
 * `lint-rules.test.ts` fails when a listed file no longer offends, so the lists cannot go stale.
 */
export const NATIVE_HOME_CLAUDE_RATCHET: ReadonlySet<string> = new Set<string>([
    "scripts/benchmarks/fs/read-child.ts",
    "scripts/benchmarks/fs/walk-trees.ts",
    "scripts/benchmarks/json/parse-child.ts",
    "scripts/benchmarks/statusline/current-statusline.ts",
    "src/agents/lib/hooks/corpus.ts",
    "src/agents/lib/hooks/diff-log.ts",
    "src/agents/lib/hooks/diff/capture.ts",
    "src/agents/lib/hooks/diff/theme.ts",
    "src/agents/lib/hooks/model.ts",
    "src/ai/commands/statusline/index.ts",
    "src/claude/commands/resume.ts",
    "src/claude/commands/tail.ts",
    "src/claude/lib/desktop/index.ts",
    "src/claude/lib/keychain-session.ts",
    "src/claude/lib/launch-env.ts",
    "src/claude/lib/memory.ts",
    "src/claude/lib/migrate-to-codex/index.ts",
    "src/claude/lib/tail-list.ts",
    "src/claude/lib/teams/discover.ts",
    "src/claude/lib/worker/store.ts",
    "src/genesis-tools-mcp/lib/http-caller.ts",
    "src/learn-from-fable/commands/instruct.ts",
    "src/learn-from-fable/lib/config.ts",
    "src/mcp-manager/lib/doctor/discovery.ts",
    "src/mcp-manager/lib/doctor/report.ts",
    "src/mcp-manager/lib/doctor/types.ts",
    "src/mcp-manager/utils/providers/claude.ts",
    "src/mcp-manager/utils/providers/grok.ts",
    "src/scripts/lib/claude-tokens.ts",
    "src/utils/ai/providers/plugins/anthropic-sub/statusline.ts",
    "src/utils/ai/statusline/config.ts",
    "src/utils/claude/keychain.ts",
    "src/utils/cli/failures/caller.ts",
    "src/utils/ts/sourcemaps/sentry-config.ts",
]);

export const NATIVE_HOME_CODEX_GROK_RATCHET: ReadonlySet<string> = new Set<string>([
    "scripts/benchmarks/fs/read-child.ts",
    "scripts/benchmarks/fs/walk-trees.ts",
    "src/ai/commands/config/account.ts",
    "src/claude/lib/migrate-to-codex/index.ts",
    "src/codex/commands/migrate-home.ts",
    "src/codex/daemon.ts",
    "src/codex/lib/migrate-home.ts",
    "src/codex/lib/run-account-terminal.ts",
    "src/codex/lib/spawn.ts",
    "src/codex/lib/store.ts",
    "src/grok/lib/worker.ts",
    "src/mcp-manager/utils/providers/codex.ts",
    "src/mcp-manager/utils/providers/grok.ts",
    "src/utils/ai/openai/codex-auth.ts",
    "src/utils/ai/transcripts/resolve.ts",
    "src/utils/ai/transcripts/session-title.ts",
    "src/utils/cli/failures/caller.ts",
    "src/utils/session-changes/codex.ts",
]);
