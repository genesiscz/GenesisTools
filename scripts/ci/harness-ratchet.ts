/*
 * The job that empties this list: handoff h_2ehgo4gz, "lint-ratchets-migration" (genesis-tools MCP handoff_get
 * { name: "lint-ratchets-migration" }). Remove a file here in the same commit that migrates it.
 */
/**
 * The files that still branch on a harness name, read a hook payload field themselves, or find a running agent by its
 * command line, counted 2026-10-25 when lint-rules `no-harness-name-branch`, `no-hook-payload-read` and
 * `no-agent-name-in-command-match` were added (❓ DECISION 22 b, a Haiku survey,
 * HarnessBranching, in the notes of 2026-10-25). Ratchets: no file may join a list, and
 * `lint-rules.test.ts` fails when a listed file no longer offends. A harness difference belongs in its provider
 * (`ProviderPlugin`, `NativeSessionReader`), a payload field in `src/agents/lib/hooks/payload.ts`, and process
 * matching in `src/utils/process/classify.ts`.
 */
export const HARNESS_BRANCH_RATCHET: ReadonlySet<string> = new Set<string>([
    "scripts/history/schema-benchmark.ts",
    "src/agents/commands/hooks.ts",
    "src/agents/lib/changes/blame.ts",
    "src/agents/lib/hooks/diff-log.ts",
    "src/agents/lib/hooks/diff/capture.ts",
    "src/agents/lib/hooks/diff/run.ts",
    "src/agents/lib/hooks/guard.ts",
    "src/ai-spend/lib/monitor.ts",
    "src/ai-spend/lib/reports/commands.ts",
    "src/ai-spend/lib/reports/load.ts",
    "src/ai-spend/lib/reports/native.ts",
    "src/ai-spend/lib/reports/period.ts",
    "src/ai-spend/lib/reports/reviews.ts",
    "src/ai-spend/lib/reports/session.ts",
    "src/ai-spend/lib/series.ts",
    "src/ai-spend/lib/workers/stats.ts",
    "src/ai/commands/agent/wait.ts",
    "src/ai/lib/agent-message/delivery.ts",
    "src/ai/lib/sessions/agent-session-rows.ts",
    "src/ai/lib/sessions/resolve-transcript.ts",
    "src/claude/commands/cmux/pins.ts",
    "src/claude/commands/resume.ts",
    "src/claude/lib/history/search.ts",
    "src/cmux/lib/render-resume.ts",
    "src/cmux/lib/restore-in-place.ts",
    "src/cmux/lib/session-agents.ts",
    "src/cmux/lib/snapshot.ts",
    "src/cmux/lib/tab-process.ts",
    "src/cmux/lib/title-match.ts",
    "src/cmux/lib/tty-capture.ts",
    "src/codex/lib/message-delivery.ts",
    "src/dev-dashboard/lib/tmux/claude-pane-title.ts",
    "src/genesis-tools-mcp/lib/http-caller.ts",
    "src/git/commands/worktree.ts",
    "src/handoff/executor.ts",
    "src/hub/lib/agents/index.ts",
    "src/hub/lib/composer/dispatch.ts",
    "src/hub/lib/insights/index.ts",
    "src/hub/lib/widget/context.ts",
    "src/hub/lib/widget/snapshot.ts",
    "src/learn-from-fable/lib/runners/index.ts",
    "src/mcp-manager/commands/list.ts",
    "src/mcp-manager/commands/rename.ts",
    "src/question/lib/decisions/deliver.ts",
    "src/question/lib/decisions/read.ts",
    "src/question/lib/decisions/store.ts",
    "src/utils/ai/openai/native-session-import.ts",
    "src/utils/ai/transcripts/around.ts",
    "src/utils/ai/transcripts/live.ts",
    "src/utils/ai/transcripts/load.ts",
    "src/utils/ai/transcripts/native-scan.ts",
    "src/utils/ai/transcripts/render/compact.ts",
    "src/utils/ai/transcripts/resolve.ts",
    "src/utils/ai/transcripts/session-title.ts",
    "src/utils/ai/transcripts/subagents.ts",
    "src/utils/ai/transcripts/turn-index.ts",
    "src/utils/cli/failures/caller.ts",
    "src/utils/worker/contract.ts",
]);

export const HOOK_PAYLOAD_READ_RATCHET: ReadonlySet<string> = new Set<string>([
    "src/agents/lib/hooks/decisions.ts",
    "src/agents/lib/hooks/diff/capture.ts",
    "src/agents/lib/hooks/diff/run.ts",
    "src/agents/lib/hooks/guard.ts",
    "src/ai-spend/lib/reports/statusline.ts",
    "src/utils/ai/providers/plugins/anthropic-sub/statusline.ts",
]);

export const AGENT_PROCESS_MATCH_RATCHET: ReadonlySet<string> = new Set<string>([
    "scripts/benchmarks/process/call-sites.ts",
    "src/claude/lib/teams/status.ts",
    "src/cmux/lib/tab-process.ts",
    "src/codex/lib/spawn.ts",
    "src/question/lib/decisions/deliver.ts",
    "src/utils/cmux/tmux-host.ts",
]);
