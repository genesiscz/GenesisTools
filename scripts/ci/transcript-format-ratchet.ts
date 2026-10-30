/*
 * The job that empties this list: handoff h_2ehgo4gz, "lint-ratchets-migration" (genesis-tools MCP handoff_get
 * { name: "lint-ratchets-migration" }). Remove a file here in the same commit that migrates it.
 */
/**
 * The files outside the provider readers that still name a coding agent's transcript format (a Claude, Codex or Grok
 * record type or field), counted 2026-10-25 when lint-rules `no-transcript-format-outside-readers` was added (Martin's
 * ❓ DECISION 22 b). A ratchet: no file may join this list, and a file leaves it once the fact it reads is a
 * `NativeSessionReader` member (.claude/rules/agent-transcripts.md). `lint-rules.test.ts` fails when a listed file no
 * longer names one, so the list cannot go stale.
 */
export const TRANSCRIPT_FORMAT_RATCHET: ReadonlySet<string> = new Set<string>([]);
