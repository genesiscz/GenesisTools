/**
 * Model ids advertised by the Codex/ChatGPT subscription proxy provider,
 * as `<account>/codex/<id>`. The upstream is the ChatGPT WHAM backend, which
 * only accepts Codex-supported models for a ChatGPT account.
 *
 * Verified live (2026-07-12, plan "plus" account): `gpt-5.5` works; `gpt-5`,
 * `gpt-5-codex`, `gpt-5.1`, `gpt-5.5-codex`, `gpt-5.1-codex` return
 * "not supported when using Codex with a ChatGPT account". `gpt-5-codex` is
 * kept advertised because higher plans (Pro) do serve it; unsupported ids
 * surface WHAM's own 400 to the caller.
 */

export const OPENAI_SUB_MODELS = ["gpt-5.5", "gpt-5-codex"] as const;

export type OpenAiSubModel = (typeof OPENAI_SUB_MODELS)[number];

/** Codex model ids are already concrete; unknown values pass through unchanged. */
export function resolveOpenAiSubModel(id: string): string {
    return id;
}
