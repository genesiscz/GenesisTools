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
export const NATIVE_HOME_CLAUDE_RATCHET: ReadonlySet<string> = new Set<string>([]);

export const NATIVE_HOME_CODEX_GROK_RATCHET: ReadonlySet<string> = new Set<string>(["src/codex/lib/spawn.ts"]);
