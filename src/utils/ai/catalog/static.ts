import type { Capability } from "../providers/plugin-types";
import type { CatalogEntry, ModelFamily, ModelPricing } from "./types";

/**
 * The hand-curated model list, for every provider.
 *
 * Before this file the same facts lived in five places — an Anthropic-only
 * registry, a Grok catalog, a WHAM catalog, an xAI fallback array inside
 * ai-proxy, and `KNOWN_MODELS` in ask, which was two Anthropic generations
 * behind and still shipping to users. Provider-specific operational data
 * (probe status, picker speed hints) deliberately stays with its provider;
 * what lives here is what every consumer needs: id, window, price, capability.
 *
 * `pricing` is the public list price and only present where a committed price
 * exists. Absent pricing means "unknown", never "free". The ai-proxy client
 * ledger keeps its own invoicing table on purpose — do not source rates from
 * here for that path.
 */

const CHAT: ReadonlySet<Capability> = new Set(["chat", "summarize", "translate"]);

/**
 * "grok-4-fast" → "Grok 4 Fast". The display name for providers that ship ids
 * and no marketing names, and the fallback for any id the catalog does not
 * carry — one derivation, so a picker and a pricing table never disagree.
 */
export function formatModelDisplayName(id: string): string {
    return id
        .split("-")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

/** Opus 4.5 and later — Anthropic dropped Opus to $5/$25 at 4.5 and kept it there. */
const OPUS_4_PRICING: ModelPricing = {
    inputPer1M: 5,
    outputPer1M: 25,
    cachedCreatePer1M: 6.25,
    cachedReadPer1M: 0.5,
};

/** Opus 4.1 predates the price drop. */
const OPUS_4_1_PRICING: ModelPricing = {
    inputPer1M: 15,
    outputPer1M: 75,
    cachedCreatePer1M: 18.75,
    cachedReadPer1M: 1.5,
};

const SONNET_4_PRICING: ModelPricing = {
    inputPer1M: 3,
    outputPer1M: 15,
    cachedCreatePer1M: 3.75,
    cachedReadPer1M: 0.3,
};

/**
 * Sonnet 4.5 is the one model here that surcharges long context: its 1M window
 * was a beta bolted onto a 200K model, and requests past 200K bill at double.
 *
 * Nothing newer carries this. Anthropic's pricing page is explicit that "Claude
 * 4.6 and later models include the full 1M token context window at standard
 * pricing (a 900k-token request is billed at the same per-token rate as a
 * 9k-token request)", and LiteLLM prices them the same way — so copying these
 * tiers onto Sonnet 4.6 or the 5 family would invent a 2x surcharge that the
 * vendor does not charge. Verified against docs.claude.com/en/docs/about-claude/pricing
 * and the LiteLLM feed on 2026-07-29.
 */
const SONNET_4_5_PRICING: ModelPricing = {
    ...SONNET_4_PRICING,
    inputPer1MAbove200k: 6,
    outputPer1MAbove200k: 22.5,
    cachedCreatePer1MAbove200k: 7.5,
    cachedReadPer1MAbove200k: 0.6,
};

function anthropic(entry: {
    id: string;
    family: ModelFamily;
    displayName: string;
    contextWindow: number;
    thinking: CatalogEntry["thinking"];
    pricing?: ModelPricing;
    aliases?: string[];
    releasedAt?: string;
    flags?: CatalogEntry["flags"];
}): CatalogEntry {
    return {
        ...entry,
        provider: "anthropic",
        capabilities: CHAT,
        // Every Claude model in this list takes client-side tools; the Messages
        // API has priced a tool-use system prompt for each one since Opus 4.
        flags: { tools: true, ...entry.flags },
        source: "static",
    };
}

/**
 * Newest first — this order is the Anthropic subscription catalog order.
 * Verified live against GET api.anthropic.com/v1/models (2026-07-12); refresh
 * via fetchAnthropicSubModels() when Anthropic ships a new family.
 */
const ANTHROPIC_ENTRIES: CatalogEntry[] = [
    anthropic({
        id: "claude-opus-5",
        family: "opus",
        displayName: "Claude Opus 5",
        contextWindow: 1_000_000,
        thinking: "reasoning",
        pricing: { inputPer1M: 5, outputPer1M: 25, cachedCreatePer1M: 6.25, cachedReadPer1M: 0.5 },
        aliases: ["opus"],
        releasedAt: "2026-07-24",
        flags: { native1m: true, cli: { label: "Opus 5 (1M native)" } },
    }),
    anthropic({
        id: "claude-sonnet-5",
        family: "sonnet",
        displayName: "Claude Sonnet 5",
        contextWindow: 1_000_000,
        thinking: "reasoning",
        // Standard list; intro $2/$10 runs through 2026-08-31 (anthropic.com/pricing).
        pricing: { inputPer1M: 3, outputPer1M: 15, cachedCreatePer1M: 3.75, cachedReadPer1M: 0.3 },
        aliases: ["sonnet"],
        // 1M is the base window, so there is no 200K mode to suffix back up.
        flags: { native1m: true, cli: { label: "Sonnet 5 (1M native)" } },
    }),
    anthropic({
        id: "claude-fable-5",
        family: "fable",
        displayName: "Claude Fable 5",
        contextWindow: 1_000_000,
        thinking: "reasoning",
        pricing: { inputPer1M: 10, outputPer1M: 50, cachedCreatePer1M: 12.5, cachedReadPer1M: 1 },
        aliases: ["fable"],
        flags: { native1m: true, cli: { label: "Fable 5 (1M native)" } },
    }),
    anthropic({
        id: "claude-opus-4-8",
        family: "opus",
        displayName: "Claude Opus 4.8",
        contextWindow: 1_000_000,
        thinking: "reasoning",
        pricing: OPUS_4_PRICING,
        flags: { supports1m: true, cli: { label: "Opus 4.8" } },
    }),
    anthropic({
        id: "claude-opus-4-7",
        family: "opus",
        displayName: "Claude Opus 4.7",
        contextWindow: 1_000_000,
        thinking: "reasoning",
        pricing: OPUS_4_PRICING,
        flags: { supports1m: true, cli: { label: "Opus 4.7" } },
    }),
    anthropic({
        id: "claude-sonnet-4-6",
        family: "sonnet",
        displayName: "Claude Sonnet 4.6",
        contextWindow: 1_000_000,
        thinking: "reasoning",
        pricing: SONNET_4_PRICING,
        flags: { supports1m: true, cli: { label: "Sonnet 4.6" } },
    }),
    anthropic({
        id: "claude-opus-4-6",
        family: "opus",
        displayName: "Claude Opus 4.6",
        contextWindow: 1_000_000,
        thinking: "reasoning",
        pricing: OPUS_4_PRICING,
        flags: { supports1m: true, cli: { label: "Opus 4.6" } },
    }),
    anthropic({
        id: "claude-opus-4-5-20251101",
        family: "opus",
        displayName: "Claude Opus 4.5",
        contextWindow: 200_000,
        thinking: "reasoning",
        pricing: OPUS_4_PRICING,
        flags: { cli: { id: "claude-opus-4-5", label: "Opus 4.5" } },
    }),
    anthropic({
        id: "claude-haiku-4-5-20251001",
        family: "haiku",
        displayName: "Claude Haiku 4.5",
        contextWindow: 200_000,
        thinking: "none",
        pricing: { inputPer1M: 1, outputPer1M: 5, cachedCreatePer1M: 1.25, cachedReadPer1M: 0.1 },
        aliases: ["haiku"],
        flags: { cli: { id: "claude-haiku-4-5", label: "Haiku 4.5" } },
    }),
    anthropic({
        id: "claude-sonnet-4-5-20250929",
        family: "sonnet",
        displayName: "Claude Sonnet 4.5",
        contextWindow: 200_000,
        thinking: "reasoning",
        pricing: SONNET_4_5_PRICING,
        flags: { cli: { id: "claude-sonnet-4-5", label: "Sonnet 4.5" } },
    }),
    anthropic({
        id: "claude-opus-4-1-20250805",
        family: "opus",
        displayName: "Claude Opus 4.1",
        contextWindow: 200_000,
        thinking: "reasoning",
        pricing: OPUS_4_1_PRICING,
    }),
];

/**
 * xAI's chat models, id + window only. Speed hints, probe status and picker
 * curation stay in `grok/models.ts`: those describe how the proxy operates a
 * model, not what the model is.
 *
 * 131_072 is xAI's default window; entries deviating from it say so. Verified
 * against xAI docs / LiteLLM 2026-07.
 */
const XAI_WINDOWS: Record<string, number> = {
    "grok-4.5": 500_000,
    "grok-4.3": 1_000_000,
    "grok-4-fast": 2_000_000,
    "grok-4-fast-reasoning": 2_000_000,
    "grok-4-fast-non-reasoning": 2_000_000,
    "grok-4.20-0309-reasoning": 1_000_000,
    "grok-4.20-0309-non-reasoning": 1_000_000,
    "grok-4.20-multi-agent-0309": 1_000_000,
    "grok-build-0.1": 256_000,
};

const XAI_DEFAULT_WINDOW = 131_072;

const XAI_VISION_MODELS = new Set(["grok-4.5", "grok-4.3"]);

/** id → thinking mode; anything unlisted reasons optionally. */
const XAI_THINKING: Record<string, CatalogEntry["thinking"]> = {
    "grok-build": "reasoning",
    "grok-composer-2.5-fast": "reasoning",
    "grok-build-0.1": "reasoning",
    "grok-code-fast": "none",
    "grok-code-fast-1": "none",
    "grok-code-fast-1-0825": "none",
    "grok-3-mini": "none",
    "grok-3-fast": "none",
    "grok-3-fast-latest": "none",
    "grok-3-mini-fast": "none",
    "grok-3-mini-fast-latest": "none",
    "grok-4-fast": "none",
    "grok-4-fast-reasoning": "reasoning",
    "grok-4-fast-non-reasoning": "none",
    "grok-4-1-fast": "none",
    "grok-4-1-fast-reasoning": "reasoning",
    "grok-4-1-fast-non-reasoning": "none",
    "grok-4.20-0309-reasoning": "reasoning",
    "grok-4.20-0309-non-reasoning": "none",
};

const XAI_IDS = [
    "grok-4.5",
    "grok-build",
    "grok-composer-2.5-fast",
    "grok-build-0.1",
    "grok-code-fast",
    "grok-code-fast-1",
    "grok-code-fast-1-0825",
    "grok-3",
    "grok-3-mini",
    "grok-3-fast",
    "grok-3-fast-latest",
    "grok-3-mini-fast",
    "grok-3-mini-fast-latest",
    "grok-4",
    "grok-4-fast",
    "grok-4-fast-reasoning",
    "grok-4-fast-non-reasoning",
    "grok-4-0709",
    "grok-4-1-fast",
    "grok-4-1-fast-reasoning",
    "grok-4-1-fast-non-reasoning",
    "grok-latest",
    "grok-4.3",
    "grok-4.20",
    "grok-4.20-multi-agent",
    "grok-4.20-0309",
    "grok-4.20-0309-reasoning",
    "grok-4.20-0309-non-reasoning",
    "grok-4.20-multi-agent-0309",
];

const XAI_ENTRIES: CatalogEntry[] = XAI_IDS.map((id) => ({
    id,
    provider: "xai",
    displayName: formatModelDisplayName(id),
    contextWindow: XAI_WINDOWS[id] ?? XAI_DEFAULT_WINDOW,
    capabilities: CHAT,
    thinking: XAI_THINKING[id] ?? "optional",
    ...(XAI_VISION_MODELS.has(id) ? { inputModalities: ["text", "image"] } : {}),
    // Both xAI paths the proxy serves advertise tool support unconditionally
    // (`supportsTools: true` in ai-proxy's xai and grok meta builders).
    flags: { tools: true },
    source: "static" as const,
}));

/**
 * Codex/ChatGPT (WHAM backend) models, newest first. Verified live against
 * GET wham/models (2026-07-12, plan "plus"); refresh via fetchWhamModels().
 * `gpt-5-codex` is not served on Plus but higher plans do serve it —
 * unsupported ids surface WHAM's own 400 to the caller.
 */
const OPENAI_SUB_ENTRIES: CatalogEntry[] = [
    { id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", contextWindow: 372_000 },
    { id: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", contextWindow: 372_000 },
    { id: "gpt-5.6-luna", displayName: "GPT-5.6-Luna", contextWindow: 372_000 },
    { id: "gpt-5.5", displayName: "GPT-5.5", contextWindow: 272_000 },
    { id: "gpt-5.4", displayName: "GPT-5.4", contextWindow: 272_000 },
    { id: "gpt-5.4-mini", displayName: "GPT-5.4-Mini", contextWindow: 272_000 },
    { id: "gpt-5-codex", displayName: "GPT-5-Codex", contextWindow: 272_000 },
].map((entry) => ({
    ...entry,
    provider: "openai-sub",
    capabilities: CHAT,
    // ai-proxy advertises every WHAM record with `supportsTools: true`.
    flags: { tools: true },
    source: "static" as const,
}));

export const STATIC_CATALOG: CatalogEntry[] = [...ANTHROPIC_ENTRIES, ...XAI_ENTRIES, ...OPENAI_SUB_ENTRIES];

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
 * Input modalities for a catalog model. Every current Anthropic model accepts
 * text + images, so entries only carry `inputModalities` when they deviate.
 */
export function inputModalitiesFor(model: CatalogEntry): string[] | undefined {
    if (model.inputModalities) {
        return model.inputModalities;
    }

    return model.provider === "anthropic" ? ["text", "image"] : undefined;
}

export function byProvider(provider: string): CatalogEntry[] {
    return STATIC_CATALOG.filter((model) => model.provider === provider);
}

/** Exact id first, then aliases — so "opus" and the dated id both resolve. */
export function byId(id: string): CatalogEntry | undefined {
    return (
        STATIC_CATALOG.find((model) => model.id === id) ??
        STATIC_CATALOG.find((model) => (model.aliases ?? []).includes(id))
    );
}

export function byCapability(capability: Capability): CatalogEntry[] {
    return STATIC_CATALOG.filter((model) => model.capabilities.has(capability));
}

/** alias → concrete id, for every model of that provider carrying aliases. */
export function aliasMapFor(provider: string): Record<string, string> {
    const map: Record<string, string> = {};

    for (const model of byProvider(provider)) {
        for (const alias of model.aliases ?? []) {
            map[alias] = model.id;
        }
    }

    return map;
}

/** The static list price. The async ladder in `pricing.ts` falls back to this. */
export function staticPricingFor(id: string): ModelPricing | undefined {
    return byId(id)?.pricing;
}
