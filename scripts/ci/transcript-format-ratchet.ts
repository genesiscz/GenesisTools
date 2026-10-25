/**
 * The files outside the provider readers that still name a coding agent's transcript format (a Claude, Codex or Grok
 * record type or field), counted 2026-10-25 when lint-rules `no-transcript-format-outside-readers` was added (Martin's
 * ❓ DECISION 22 b). A ratchet: no file may join this list, and a file leaves it once the fact it reads is a
 * `NativeSessionReader` member (.claude/rules/agent-transcripts.md). `lint-rules.test.ts` fails when a listed file no
 * longer names one, so the list cannot go stale.
 */
export const TRANSCRIPT_FORMAT_RATCHET: ReadonlySet<string> = new Set<string>([
    "src/agents/lib/hooks/decisions.ts",
    "src/claude/lib/usage/session-rows.ts",
    "src/hub/lib/agents/codex-agents.ts",
    "src/hub/lib/widget/roster-index.ts",
    "src/utils/agents/adapters/claude.ts",
    "src/utils/ai/openai/native-session-import.ts",
    "src/utils/ai/transcripts/around.ts",
    "src/utils/ai/transcripts/codex.ts",
    "src/utils/ai/transcripts/native-scan.ts",
    "src/utils/ai/transcripts/subagents.ts",
    "src/utils/ai/transcripts/turn-state.ts",
    "src/utils/ai/usage/transcripts/codex-context.ts",
    "src/utils/ai/usage/transcripts/codex.ts",
    "src/utils/cli/failures/caller.ts",
    "src/utils/session-changes/codex.ts",
]);
