/**
 * The one hand-curated LLM model registry. Everything else that used to keep
 * its own literal list (the Anthropic subscription catalog, the `claude
 * --model` launcher list, ai-spend's default pricing table) is a derived view
 * over `MODEL_REGISTRY`.
 *
 * Scope today is Anthropic. Grok (`@genesiscz/utils/ai/grok/models`) and
 * Codex/WHAM (`@genesiscz/utils/ai/openai/sub-models`) keep their own catalogs
 * because their records carry provider-specific fields (probe status, speed,
 * visibility, input modalities) that do not belong here.
 *
 * `pricing` is the public list price and is only present where a committed
 * price exists. Absent pricing means "unknown", never "free". The ai-proxy
 * client ledger deliberately keeps its own invoicing table
 * (`src/ai-proxy/lib/billing/pricing.ts`) — do not source rates from here for
 * that path.
 */

export type ModelProvider = "anthropic" | "grok" | "openai" | "github-copilot";

export type ModelFamily = "opus" | "sonnet" | "haiku" | "fable";

export interface ModelPricing {
    /** USD per 1M input tokens. */
    inputPerMTok: number;
    /** USD per 1M output tokens. */
    outputPerMTok: number;
    cacheReadPerMTok?: number;
    cacheWritePerMTok?: number;
}

export interface CanonicalModel {
    /** Concrete id accepted by the provider API (dated where the API requires it). */
    id: string;
    provider: ModelProvider;
    family: ModelFamily;
    displayName: string;
    contextWindow: number;
    maxOutput?: number;
    thinking: "reasoning" | "none" | "optional";
    pricing?: ModelPricing;
    /** Only set when deviating from the provider default (see inputModalitiesFor). */
    inputModalities?: string[];
    /** Short names that resolve to this id, e.g. "opus". */
    aliases?: string[];
    releasedAt?: string;
    flags?: {
        /** Accepts the `[1m]` 1M-context variant suffix in Claude Code. */
        supports1m?: boolean;
        /** Serves 1M context without a variant suffix. */
        native1m?: boolean;
    };
    /** Present when the model is launchable via `claude --model`. */
    cli?: {
        /** Only when the CLI id differs from `id` (the CLI takes undated ids). */
        id?: string;
        label: string;
    };
}

/** Opus 4.5 and later — Anthropic dropped Opus to $5/$25 at 4.5 and kept it there. */
const OPUS_4_PRICING: ModelPricing = {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheWritePerMTok: 6.25,
    cacheReadPerMTok: 0.5,
};

/** Opus 4.1 predates the price drop. */
const OPUS_4_1_PRICING: ModelPricing = {
    inputPerMTok: 15,
    outputPerMTok: 75,
    cacheWritePerMTok: 18.75,
    cacheReadPerMTok: 1.5,
};

const SONNET_4_PRICING: ModelPricing = {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheWritePerMTok: 3.75,
    cacheReadPerMTok: 0.3,
};

/**
 * Newest first — this order is the Anthropic subscription catalog order.
 * Verified live against GET api.anthropic.com/v1/models (2026-07-12); refresh
 * via fetchAnthropicSubModels() when Anthropic ships a new family.
 */
export const MODEL_REGISTRY: CanonicalModel[] = [
    {
        id: "claude-opus-5",
        provider: "anthropic",
        family: "opus",
        displayName: "Claude Opus 5",
        contextWindow: 1_000_000,
        thinking: "reasoning",
        pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 },
        aliases: ["opus"],
        releasedAt: "2026-07-24",
        flags: { native1m: true },
        cli: { label: "Opus 5 (1M native)" },
    },
    {
        id: "claude-sonnet-5",
        provider: "anthropic",
        family: "sonnet",
        displayName: "Claude Sonnet 5",
        contextWindow: 1_000_000,
        thinking: "reasoning",
        // Standard list; intro $2/$10 runs through 2026-08-31 (anthropic.com/pricing).
        pricing: { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 },
        aliases: ["sonnet"],
        // 1M is the base window, so there is no 200K mode to suffix back up.
        flags: { native1m: true },
        cli: { label: "Sonnet 5 (1M native)" },
    },
    {
        id: "claude-fable-5",
        provider: "anthropic",
        family: "fable",
        displayName: "Claude Fable 5",
        contextWindow: 1_000_000,
        thinking: "reasoning",
        pricing: { inputPerMTok: 10, outputPerMTok: 50, cacheWritePerMTok: 12.5, cacheReadPerMTok: 1 },
        aliases: ["fable"],
        flags: { native1m: true },
        cli: { label: "Fable 5 (1M native)" },
    },
    {
        id: "claude-opus-4-8",
        provider: "anthropic",
        family: "opus",
        displayName: "Claude Opus 4.8",
        contextWindow: 1_000_000,
        thinking: "reasoning",
        pricing: OPUS_4_PRICING,
        flags: { supports1m: true },
        cli: { label: "Opus 4.8" },
    },
    {
        id: "claude-opus-4-7",
        provider: "anthropic",
        family: "opus",
        displayName: "Claude Opus 4.7",
        contextWindow: 1_000_000,
        thinking: "reasoning",
        pricing: OPUS_4_PRICING,
        flags: { supports1m: true },
        cli: { label: "Opus 4.7" },
    },
    {
        id: "claude-sonnet-4-6",
        provider: "anthropic",
        family: "sonnet",
        displayName: "Claude Sonnet 4.6",
        contextWindow: 1_000_000,
        thinking: "reasoning",
        pricing: SONNET_4_PRICING,
        flags: { supports1m: true },
        cli: { label: "Sonnet 4.6" },
    },
    {
        id: "claude-opus-4-6",
        provider: "anthropic",
        family: "opus",
        displayName: "Claude Opus 4.6",
        contextWindow: 1_000_000,
        thinking: "reasoning",
        pricing: OPUS_4_PRICING,
        flags: { supports1m: true },
        cli: { label: "Opus 4.6" },
    },
    {
        id: "claude-opus-4-5-20251101",
        provider: "anthropic",
        family: "opus",
        displayName: "Claude Opus 4.5",
        contextWindow: 200_000,
        thinking: "reasoning",
        pricing: OPUS_4_PRICING,
        cli: { id: "claude-opus-4-5", label: "Opus 4.5" },
    },
    {
        id: "claude-haiku-4-5-20251001",
        provider: "anthropic",
        family: "haiku",
        displayName: "Claude Haiku 4.5",
        contextWindow: 200_000,
        thinking: "none",
        pricing: { inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.1 },
        aliases: ["haiku"],
        cli: { id: "claude-haiku-4-5", label: "Haiku 4.5" },
    },
    {
        id: "claude-sonnet-4-5-20250929",
        provider: "anthropic",
        family: "sonnet",
        displayName: "Claude Sonnet 4.5",
        contextWindow: 200_000,
        thinking: "reasoning",
        pricing: SONNET_4_PRICING,
        cli: { id: "claude-sonnet-4-5", label: "Sonnet 4.5" },
    },
    {
        id: "claude-opus-4-1-20250805",
        provider: "anthropic",
        family: "opus",
        displayName: "Claude Opus 4.1",
        contextWindow: 200_000,
        thinking: "reasoning",
        pricing: OPUS_4_1_PRICING,
    },
];

/**
 * Strip a trailing date (`-YYYYMMDD`) or `-latest` variant suffix so dated ids
 * resolve to their base model. Boundary-safe by construction — never an
 * open-ended prefix match (which once billed grok-4.5 at grok-4's rate).
 * Returns null when the id carries no such suffix.
 */
export function stripModelVariantSuffix(id: string): string | null {
    const match = id.match(/^(.+)-(?:\d{8}|latest)$/);
    return match ? match[1] : null;
}

/** Dated snapshot ids (…-YYYYMMDD); pickers hide these in favor of the family head. */
export function isDatedModelId(id: string): boolean {
    return /-\d{8}$/.test(id);
}

/**
 * Input modalities for a registry model. Every current Anthropic model accepts
 * text + images, so entries only carry `inputModalities` when they deviate.
 */
export function inputModalitiesFor(model: CanonicalModel): string[] | undefined {
    if (model.inputModalities) {
        return model.inputModalities;
    }

    return model.provider === "anthropic" ? ["text", "image"] : undefined;
}

export function byProvider(provider: ModelProvider): CanonicalModel[] {
    return MODEL_REGISTRY.filter((model) => model.provider === provider);
}

export function byId(id: string): CanonicalModel | undefined {
    return MODEL_REGISTRY.find((model) => model.id === id);
}

/** alias → concrete id, for every model of that provider carrying aliases. */
export function aliasMapFor(provider: ModelProvider): Record<string, string> {
    const map: Record<string, string> = {};

    for (const model of byProvider(provider)) {
        for (const alias of model.aliases ?? []) {
            map[alias] = model.id;
        }
    }

    return map;
}

export function pricingFor(id: string): ModelPricing | undefined {
    return byId(id)?.pricing;
}
