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
export const MODEL_ID_LITERAL_RATCHET: ReadonlySet<string> = new Set<string>([
    ".claude/skills/babysit/scripts/review-brief.ts",
    "scripts/ai-proxy/structured-output.ts",
    "scripts/benchmarks/compress/read-paths.ts",
    "scripts/benchmarks/statusline/current-statusline.ts",
    "scripts/learn-from-fable/probe-claude-sub-concurrency.ts",
    "scripts/learn-from-fable/probe-extractor-latency.ts",
    "scripts/learn-from-fable/probe-judge-batch.ts",
    "scripts/learn-from-fable/probe-parallel-grok.ts",
    "scripts/learn-from-fable/probe-prompt-size-ceiling.ts",
    "scripts/learn-from-fable/probe-raw-frames.ts",
    "scripts/learn-from-fable/probe-stream-vs-plain.ts",
    "scripts/learn-from-fable/probe-tighten-guards.ts",
    "scripts/learn-from-fable/tighten-spec.ts",
    "src/ai-proxy/scripts/verify-openrouter-live.ts",
    "src/ai-spend/lib/workers/cost.ts",
    "src/ai/commands/config/tui.ts",
    "src/ai/lib/tokens.ts",
    "src/claude/commands/start.ts",
    "src/claude/lib/launch-env.ts",
    "src/dashboard/apps/web/src/routes/api.ai-chat.ts",
    "src/grok/lib/driver.ts",
    "src/grok/lib/launcher.ts",
    "src/learn-from-fable/lib/config.ts",
    "src/telegram/lib/types.ts",
    "src/utils/ai/providers/AICloudProvider.ts",
    "src/utils/ai/providers/openai/AIOpenAITextToSpeechProvider.ts",
    "src/utils/ai/providers/plugins/anthropic-sub/quota-headers.ts",
    "src/utils/claude/account-fingerprint.ts",
    "src/utils/claude/token-verify.ts",
    "src/youtube/lib/config.ts",
]);

export const MODEL_PRICE_TABLE_RATCHET: ReadonlySet<string> = new Set<string>([]);

export const EFFORT_LIST_RATCHET: ReadonlySet<string> = new Set<string>([
    "src/ai-proxy/lib/resolve-model.ts",
    "src/ai-proxy/lib/types.ts",
    "src/utils/agent-harness/llm.ts",
    "src/utils/ai/providers/plugins/openrouter.ts",
    "src/utils/worker/contract.ts",
]);
