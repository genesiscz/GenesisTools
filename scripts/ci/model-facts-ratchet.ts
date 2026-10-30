/*
 * The job that empties this list: handoff h_2ehgo4gz, "lint-ratchets-migration" (genesis-tools MCP handoff_get
 * { name: "lint-ratchets-migration" }). Remove a file here in the same commit that migrates it.
 */
/**
 * The files that still write a model fact the catalog owns (.claude/rules/models.md), counted 2026-10-25 when
 * lint-rules `no-model-id-literal-outside-catalog`, `no-model-price-table` and `no-effort-vocabulary-list` were added
 * (❓ DECISION 22 b, a Haiku survey, ModelFacts, in the notes of 2026-10-25).
 * Ratchets: no file may join a list, and `lint-rules.test.ts` fails when a listed file no longer offends.
 */
export const MODEL_ID_LITERAL_RATCHET: ReadonlySet<string> = new Set<string>([]);

export const MODEL_PRICE_TABLE_RATCHET: ReadonlySet<string> = new Set<string>([]);

export const EFFORT_LIST_RATCHET: ReadonlySet<string> = new Set<string>([]);
