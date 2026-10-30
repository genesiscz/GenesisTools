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
    "src/claude/commands/resume.ts",
    "src/cmux/lib/tab-process.ts",
    "src/genesis-tools-mcp/lib/http-caller.ts",
    "src/question/lib/decisions/deliver.ts",
    "src/utils/ai/transcripts/around.ts",
    "src/utils/ai/transcripts/native-scan.ts",
    "src/utils/ai/transcripts/resolve.ts",
    "src/utils/ai/transcripts/session-title.ts",
    "src/utils/ai/transcripts/subagents.ts",
    "src/utils/cli/failures/caller.ts",
]);

export const HOOK_PAYLOAD_READ_RATCHET: ReadonlySet<string> = new Set<string>([]);

export const AGENT_PROCESS_MATCH_RATCHET: ReadonlySet<string> = new Set<string>([]);
