/**
 * Alias → concrete model id map for the Claude subscription proxy provider.
 * Aliases are advertised as `<account>/claude-sub/<alias>`; the provider
 * forwards the concrete id to api.anthropic.com/v1/messages.
 *
 * Concrete ids verified live against GET api.anthropic.com/v1/models with a
 * subscription OAuth token (2026-07-12). The bare `claude-haiku-4-5` is NOT
 * served — the dated id is required.
 */

export const ANTHROPIC_SUB_ALIASES = ["sonnet", "opus", "haiku", "fable"] as const;

export type AnthropicSubAlias = (typeof ANTHROPIC_SUB_ALIASES)[number];

const ANTHROPIC_SUB_MODEL_MAP: Record<AnthropicSubAlias, string> = {
    sonnet: "claude-sonnet-4-6",
    opus: "claude-opus-4-6",
    haiku: "claude-haiku-4-5-20251001",
    fable: "claude-fable-5",
};

/**
 * Resolve an alias to its concrete Anthropic model id. Unknown values pass
 * through unchanged so a client can also request a concrete id directly
 * (e.g. `<account>/claude-sub/claude-sonnet-5`).
 */
export function resolveAnthropicSubModel(alias: string): string {
    return ANTHROPIC_SUB_MODEL_MAP[alias as AnthropicSubAlias] ?? alias;
}
