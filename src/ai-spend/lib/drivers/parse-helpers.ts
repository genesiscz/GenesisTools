/**
 * Shared JSONL-parsing primitives for the agent drivers. Each driver had its own
 * identical copy, which is one place for the two to drift the moment one of them
 * is hardened.
 */

export { isRecord, num } from "@genesiscz/utils/ai/usage/transcripts/parse-helpers";
