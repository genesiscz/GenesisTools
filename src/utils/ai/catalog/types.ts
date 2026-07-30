import type { Capability } from "../providers/plugin-types";

/**
 * What the AI layer knows about a model.
 *
 * One shape for every provider, so a consumer never has to ask "is this an
 * Anthropic record or a Grok record" before reading a context window. Records
 * arrive from three places — the curated static list, a provider's own
 * `listModels`, and the LiteLLM/OpenRouter price feeds — and `source` says which,
 * because "we made this up" and "the provider told us" deserve different trust.
 */

export type CatalogSource = "static" | "live" | "litellm" | "openrouter";

/** Anthropic-only grouping the `claude --model` launcher renders by. */
export type ModelFamily = "opus" | "sonnet" | "haiku" | "fable";

/**
 * USD per 1M tokens.
 *
 * The `Above200k` variants exist because Anthropic and Google price long
 * context differently past a threshold; a single rate would silently
 * under-bill exactly the calls that cost the most.
 */
export interface ModelPricing {
    inputPer1M: number;
    outputPer1M: number;
    cachedReadPer1M?: number;
    cachedCreatePer1M?: number;
    inputPer1MAbove200k?: number;
    outputPer1MAbove200k?: number;
    cachedReadPer1MAbove200k?: number;
    cachedCreatePer1MAbove200k?: number;
}

export interface CatalogEntry {
    /** Concrete id the provider API accepts (dated where the API requires it). */
    id: string;
    provider: string;
    displayName: string;
    contextWindow: number;
    maxOutput?: number;
    capabilities: ReadonlySet<Capability>;
    thinking?: "reasoning" | "none" | "optional";
    /** List price. Absent means unknown — never free. */
    pricing?: ModelPricing;
    /** Short names that resolve to this id, e.g. "opus". */
    aliases?: string[];
    releasedAt?: string;
    /** Only set when deviating from the provider default (see inputModalitiesFor). */
    inputModalities?: string[];
    family?: ModelFamily;
    flags?: {
        /** Accepts the `[1m]` 1M-context variant suffix in Claude Code. */
        supports1m?: boolean;
        /** Serves 1M context without a variant suffix. */
        native1m?: boolean;
        /** Pickers hide it; it stays listed for id resolution. */
        hidden?: boolean;
        /** Present when the model is launchable via `claude --model`. */
        cli?: { id?: string; label: string };
    };
    source: CatalogSource;
}
