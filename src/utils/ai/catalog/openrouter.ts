import { existsSync, readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { aiDataDir } from "../config/paths";
import type { Capability } from "../providers/plugin-types";
import { convertOpenRouterPricing, type OpenRouterPricingShape } from "./pricing";
import { formatModelDisplayName } from "./static";
import type { CatalogEntry, ModelPricing } from "./types";

/**
 * The one OpenRouter model + price catalog, shared by `src/utils/ai/` and
 * `src/ai-proxy/`.
 *
 * It lives in the catalog layer rather than in the plugin or in ai-proxy because
 * both surfaces need it and `src/utils/ai/` must never import ai-proxy. Three
 * readers with three different needs are served:
 *
 * - `fetchOpenRouterCatalog` — async, refreshes over HTTP, writes the disk cache.
 * - `openRouterCatalogSync` — sync, memoized, ZERO network. This is what the
 *   usage hot path uses, preserving the no-HTTP-while-recording invariant stated
 *   at `usage/record.ts`.
 * - `openRouterPricingSync` / `openRouterExtras` — per-model views of the above.
 *
 * Staleness is served, never discarded: an unreachable feed must degrade to an
 * old price, not to no price, because `recordUsage` is append-only and never
 * recomputes a cost it failed to book.
 */

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const REFRESH_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * The curated `/v1/models` default: the vendors a user of this repo actually
 * calls. Broad enough that `anthropic/`, `openai/`, `google/`, `x-ai/`,
 * `deepseek/`, `qwen/`, `moonshotai/` and `meta-llama/` are all reachable
 * without configuration; narrow enough that a client listing does not have to
 * page through 400 rows of finetunes and roleplay merges.
 */
export const DEFAULT_OPENROUTER_INCLUDE: readonly string[] = [
    "anthropic/*",
    "openai/*",
    "google/*",
    "x-ai/*",
    "deepseek/*",
    "qwen/*",
    "moonshotai/*",
    "meta-llama/*",
    "mistralai/*",
    "z-ai/*",
    "minimax/*",
    "amazon/*",
    "cohere/*",
    "perplexity/*",
    "nvidia/*",
];

/**
 * Free routes are excluded by default: they are rate-limited, they route to
 * whichever upstream is donating capacity, and a client that silently lands on
 * one gets throughput nobody asked for. An explicit `[]` opts back in.
 */
export const DEFAULT_OPENROUTER_EXCLUDE: readonly string[] = ["*:free"];

/** The five meta routes OpenRouter quotes at `-1`; they are router pseudo-models, not models. */
export const OPENROUTER_META_MODEL_IDS: readonly string[] = [
    "openrouter/auto",
    "openrouter/auto-beta",
    "openrouter/fusion",
    "openrouter/pareto-code",
    "openrouter/bodybuilder",
];

/** OpenRouter's own reasoning declaration, which beats guessing from the model id. */
export interface OpenRouterReasoning {
    mandatory?: boolean;
    default_enabled?: boolean;
    supported_efforts?: string[];
    default_effort?: string;
    supports_max_tokens?: boolean;
}

export interface OpenRouterArchitecture {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
    tokenizer?: string;
}

/** The non-token fees, quoted alongside the per-token ones. */
export interface OpenRouterExtraFeeFields {
    /** USD per input image token. */
    image?: string | number;
    /** USD per GENERATED image. */
    image_output?: string | number;
    /** USD per input audio token. */
    audio?: string | number;
    /** USD per output audio token. */
    audio_output?: string | number;
    /** USD per cached input audio token. */
    input_audio_cache?: string | number;
    /** USD per web-search request. */
    web_search?: string | number;
    /** USD per internal reasoning token. */
    internal_reasoning?: string | number;
    /** USD per cache-write token at the 1 hour TTL. */
    input_cache_write_1h?: string | number;
    /** USD per request regardless of tokens. */
    request?: string | number;
}

/**
 * The pruned model record. Exactly the fields the snapshot keeps, so a consumer
 * cannot come to depend on a field the committed file does not carry.
 */
export interface OpenRouterModelRecord {
    id: string;
    name?: string;
    context_length?: number;
    pricing?: OpenRouterPricingShape & OpenRouterExtraFeeFields;
    architecture?: OpenRouterArchitecture;
    supported_parameters?: string[];
    reasoning?: OpenRouterReasoning;
}

export interface OpenRouterCatalog {
    fetchedAt: string;
    models: OpenRouterModelRecord[];
}

/**
 * Fees that are not per prompt/completion token, in USD as the feed quotes them.
 *
 * Deliberately NOT folded into `ModelPricing`: that type feeds
 * `calculateCallCostUsd`, which understands prompt and completion tokens only,
 * so a field nothing reads would make a cost total LOOK complete while charging
 * nothing for the image or the web search that actually ran.
 */
export interface OpenRouterPricingExtras {
    imagePerToken?: number;
    imageOutputPerImage?: number;
    audioPerToken?: number;
    audioOutputPerToken?: number;
    inputAudioCachePerToken?: number;
    webSearchPerRequest?: number;
    internalReasoningPerToken?: number;
    cacheWrite1hPerToken?: number;
    requestPerRequest?: number;
}

interface SnapshotState {
    catalog: OpenRouterCatalog | undefined;
    index: Map<string, OpenRouterModelRecord>;
}

let state: SnapshotState | undefined;

function diskCachePath(): string {
    return aiDataDir("cache", "openrouter-models.json");
}

function toCatalog(payload: unknown, fetchedAt: string): OpenRouterCatalog | undefined {
    const models = (payload as { data?: unknown } | undefined)?.data;

    if (!Array.isArray(models)) {
        return undefined;
    }

    return { fetchedAt, models: models.filter((model): model is OpenRouterModelRecord => isModelRecord(model)) };
}

function isModelRecord(model: unknown): boolean {
    return typeof model === "object" && model !== null && typeof (model as { id?: unknown }).id === "string";
}

function readCatalogFile(path: string): OpenRouterCatalog | undefined {
    try {
        if (!existsSync(path)) {
            return undefined;
        }

        const parsed = SafeJSON.parse(readFileSync(path, "utf8")) as OpenRouterCatalog;

        return Array.isArray(parsed?.models) ? parsed : undefined;
    } catch (err) {
        // A corrupt cache is recoverable (the snapshot is next in line), so this
        // must not throw into a caller that only wanted a price.
        logger.debug({ err, path }, "openrouter catalog file unreadable");
        return undefined;
    }
}

/**
 * The committed fallback, loaded LAZILY.
 *
 * A top-level `import` of the ~200 KB JSON would tax every tool that touches the
 * catalog barrel with a parse it does not need. `new URL(..., import.meta.url)`
 * resolves next to this module whether it runs from source or from a bundle.
 */
function readSnapshot(): OpenRouterCatalog | undefined {
    try {
        const path = new URL("./data/openrouter-snapshot.json", import.meta.url);
        const parsed = SafeJSON.parse(readFileSync(path, "utf8")) as OpenRouterCatalog;

        return Array.isArray(parsed?.models) ? parsed : undefined;
    } catch (err) {
        logger.debug({ err }, "committed openrouter snapshot unreadable");
        return undefined;
    }
}

function indexOf(catalog: OpenRouterCatalog | undefined): Map<string, OpenRouterModelRecord> {
    const index = new Map<string, OpenRouterModelRecord>();

    for (const model of catalog?.models ?? []) {
        index.set(model.id, model);
    }

    return index;
}

function loadState(): SnapshotState {
    if (state) {
        return state;
    }

    // Disk cache first (it is the fresher of the two), then the committed
    // snapshot. No age check: a stale price beats no price.
    const catalog = readCatalogFile(diskCachePath()) ?? readSnapshot();

    if (!catalog) {
        logger.debug("openrouter catalog unavailable from disk cache and snapshot");
    }

    state = { catalog, index: indexOf(catalog) };
    return state;
}

/** Drops the memo so a later read re-resolves. For tests and for post-refresh reload. */
export function resetOpenRouterCatalogCache(): void {
    state = undefined;
}

/** The catalog without touching the network. `undefined` only when neither source exists. */
export function openRouterCatalogSync(): OpenRouterCatalog | undefined {
    return loadState().catalog;
}

export function openRouterModelSync(modelId: string): OpenRouterModelRecord | undefined {
    return loadState().index.get(modelId);
}

/** Every model the catalog knows, empty when it is unavailable. */
export function openRouterModelsSync(): OpenRouterModelRecord[] {
    return loadState().catalog?.models ?? [];
}

export function openRouterPricingSync(modelId: string): ModelPricing | undefined {
    const pricing = openRouterModelSync(modelId)?.pricing;

    return pricing ? convertOpenRouterPricing(pricing) : undefined;
}

function fee(value: string | number | undefined): number | undefined {
    if (value === undefined) {
        return undefined;
    }

    const parsed = typeof value === "string" ? Number.parseFloat(value) : value;

    // Negative is the same `-1` sentinel the per-token rates use.
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function openRouterExtras(modelId: string): OpenRouterPricingExtras | undefined {
    const pricing = openRouterModelSync(modelId)?.pricing;

    if (!pricing) {
        return undefined;
    }

    const extras: OpenRouterPricingExtras = {
        ...withKey("imagePerToken", fee(pricing.image)),
        ...withKey("imageOutputPerImage", fee(pricing.image_output)),
        ...withKey("audioPerToken", fee(pricing.audio)),
        ...withKey("audioOutputPerToken", fee(pricing.audio_output)),
        ...withKey("inputAudioCachePerToken", fee(pricing.input_audio_cache)),
        ...withKey("webSearchPerRequest", fee(pricing.web_search)),
        ...withKey("internalReasoningPerToken", fee(pricing.internal_reasoning)),
        ...withKey("cacheWrite1hPerToken", fee(pricing.input_cache_write_1h)),
        ...withKey("requestPerRequest", fee(pricing.request)),
    };

    return Object.keys(extras).length === 0 ? undefined : extras;
}

function withKey<K extends keyof OpenRouterPricingExtras>(
    key: K,
    value: number | undefined
): Partial<OpenRouterPricingExtras> {
    return value === undefined ? {} : { [key]: value };
}

/**
 * OpenRouter tells us what a model can do; nothing here is inferred from the id.
 *
 * `thinking` reads the `reasoning` object: mandatory reasoning is `"reasoning"`,
 * an optional one is `"optional"`, and an absent one leaves the field unset
 * rather than claiming `"none"` — the catalog's convention for "not stated".
 */
export function toCatalogEntry(model: OpenRouterModelRecord): CatalogEntry {
    const outputs = model.architecture?.output_modalities ?? [];
    const inputs = model.architecture?.input_modalities ?? [];
    const parameters = model.supported_parameters ?? [];
    const pricing = model.pricing ? convertOpenRouterPricing(model.pricing) : undefined;
    const capabilities = new Set<Capability>(["chat"]);

    if (outputs.includes("image")) {
        capabilities.add("image");
    }

    return {
        id: model.id,
        provider: "openrouter",
        displayName: model.name || formatModelDisplayName(model.id),
        contextWindow: model.context_length ?? 4096,
        capabilities,
        ...(model.reasoning
            ? { thinking: model.reasoning.mandatory ? ("reasoning" as const) : ("optional" as const) }
            : {}),
        ...(pricing ? { pricing } : {}),
        ...(inputs.length > 0 ? { inputModalities: inputs } : {}),
        ...(parameters.includes("tools") ? { flags: { tools: true } } : {}),
        source: "openrouter" as const,
    };
}

export interface FetchOpenRouterCatalogOptions {
    /** Injectable for tests; defaults to the global. */
    fetch?: typeof globalThis.fetch;
    /** Refresh even when the disk cache is inside the TTL. */
    force?: boolean;
}

/**
 * Refresh the catalog over HTTP, writing the disk cache on success.
 *
 * Unauthenticated on purpose: `/api/v1/models` is public, and requiring a key
 * would mean a user could not SEE what the account they are about to configure
 * would offer. Never throws — a caller wanting models must not have to handle
 * the network, and every failure path still answers with cached or committed
 * data.
 */
export async function fetchOpenRouterCatalog(
    options: FetchOpenRouterCatalogOptions = {}
): Promise<OpenRouterCatalog | undefined> {
    const path = diskCachePath();
    const cached = readCatalogFile(path);
    const age = cached ? Date.now() - Date.parse(cached.fetchedAt) : Number.POSITIVE_INFINITY;

    if (!options.force && cached && Number.isFinite(age) && age < REFRESH_TTL_MS) {
        return cached;
    }

    const doFetch = options.fetch ?? globalThis.fetch;

    try {
        const response = await doFetch(OPENROUTER_MODELS_URL, { headers: { "X-Title": "GenesisTools" } });

        if (!response.ok) {
            throw new Error(`OpenRouter models API error: ${response.status}`);
        }

        // The public feed is an external machine boundary: strict parse, never comment-tolerant.
        const catalog = toCatalog(SafeJSON.parse(await response.text(), { strict: true }), new Date().toISOString());

        if (!catalog || catalog.models.length === 0) {
            throw new Error("OpenRouter models API returned no usable models");
        }

        atomicWriteFileSync(path, SafeJSON.stringify(catalog));
        resetOpenRouterCatalogCache();
        logger.debug({ count: catalog.models.length }, "refreshed the openrouter catalog");

        return catalog;
    } catch (err) {
        // Debug, never warn: being offline is not an error for a price lookup
        // that has a cached and a committed answer behind it.
        logger.debug({ err }, "openrouter catalog refresh failed — serving cached or committed data");
        return cached ?? readSnapshot();
    }
}
