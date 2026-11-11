import { logger } from "@genesiscz/utils/logger";
import { fetchDirect } from "@genesiscz/utils/net/fetch-direct";
import { WHAM_BASE_URL } from "./codex-auth";
import { OPENAI_SUB_STATIC_CATALOG, type WhamModelRecord } from "./sub-models-static";

export { OPENAI_SUB_STATIC_CATALOG, type WhamModelRecord } from "./sub-models-static";

/**
 * Built-in aliases resolved against the static catalog (first list-visible
 * match). Config aliases (per proxy account) win over built-ins; unknown ids
 * pass through unchanged so WHAM's own 400 surfaces for bad slugs.
 */
export const OPENAI_SUB_BUILTIN_ALIAS_NAMES = [
    "latest",
    "codex",
    "mini",
    "astra",
    "terra",
    "luna",
    "sol",
    "sol6",
] as const;

const OPENAI_SUB_BUILTIN_ALIASES: Record<string, (catalog: WhamModelRecord[]) => string | undefined> = {
    astra: () => "gpt-6-astra",
    terra: () => "gpt-6.1-terra",
    luna: () => "gpt-6-luna",
    sol: () => "gpt-6.1-sol",
    sol6: () => "gpt-6-sol",
    latest: (catalog) => catalog.find((record) => record.visibility === "list")?.slug,
    codex: (catalog) =>
        catalog.find((record) => record.visibility === "list" && record.slug.includes("codex"))?.slug ??
        catalog.find((record) => record.visibility === "list")?.slug,
    mini: (catalog) => catalog.find((record) => record.visibility === "list" && record.slug.includes("mini"))?.slug,
};

export function resolveOpenAiSubModel(id: string, aliases?: Record<string, string>): string {
    const fromConfig = aliases?.[id];

    if (fromConfig) {
        return fromConfig;
    }

    const builtin = OPENAI_SUB_BUILTIN_ALIASES[id];

    if (builtin) {
        return builtin(OPENAI_SUB_STATIC_CATALOG) ?? id;
    }

    return id;
}

const WHAM_CLIENT_VERSION = "1.0.26";

/** One record of WHAM `GET /models`, and of the Codex CLI's `models_cache.json` (the same schema). */
export interface WhamApiModel {
    slug: string;
    display_name: string;
    context_window: number;
    visibility: "list" | "hide";
    input_modalities?: string[];
    supports_parallel_tool_calls?: boolean;
    supported_reasoning_levels?: Array<{ effort?: string }>;
    default_reasoning_level?: string;
    effective_context_window_percent?: number;
    max_context_window?: number;
    auto_compact_token_limit?: number | null;
    use_responses_lite?: boolean;
    comp_hash?: string;
    supports_search_tool?: boolean;
    web_search_tool_type?: string;
    multi_agent_reasoning_effort?: string | null;
    default_reasoning_summary?: string;
    supports_reasoning_summary_parameter?: boolean | null;
}

interface WhamModelsResponse {
    models: WhamApiModel[];
}

/** Map one API record onto `WhamModelRecord`; a null or missing field stays undefined so a lower source can fill it. */
export function whamModelRecordFromApi(m: WhamApiModel): WhamModelRecord {
    const efforts = (m.supported_reasoning_levels ?? [])
        .map((level) => level.effort)
        .filter((effort): effort is string => typeof effort === "string");

    return {
        slug: m.slug,
        displayName: m.display_name,
        contextWindow: m.context_window,
        visibility: m.visibility,
        inputModalities: m.input_modalities,
        supportsParallelToolCalls: m.supports_parallel_tool_calls ?? undefined,
        supportedEfforts: efforts.length > 0 ? efforts : undefined,
        defaultEffort: m.default_reasoning_level ?? undefined,
        effectiveContextWindowPercent: m.effective_context_window_percent ?? undefined,
        maxContextWindow: m.max_context_window ?? undefined,
        autoCompactTokenLimit: m.auto_compact_token_limit ?? undefined,
        useResponsesLite: m.use_responses_lite ?? undefined,
        compHash: m.comp_hash ?? undefined,
        supportsSearchTool: m.supports_search_tool ?? undefined,
        webSearchToolType: m.web_search_tool_type ?? undefined,
        multiAgentReasoningEffort: m.multi_agent_reasoning_effort ?? undefined,
        defaultReasoningSummary: m.default_reasoning_summary ?? undefined,
        supportsReasoningSummaryParameter: m.supports_reasoning_summary_parameter ?? undefined,
    };
}

/**
 * Live WHAM `/models` list (no fallback). Returns null on failure so callers
 * can mark availability honestly (live ok vs static skip).
 */
/** `baseUrl`: a WHAM-compatible endpoint a proxy account points at (its `baseUrl`), else chatgpt.com's. */
export async function tryFetchWhamModels(
    accessToken: string,
    accountId?: string,
    baseUrl: string = WHAM_BASE_URL
): Promise<WhamModelRecord[] | null> {
    try {
        const headers: Record<string, string> = {
            Authorization: `Bearer ${accessToken}`,
        };

        if (accountId) {
            headers["ChatGPT-Account-Id"] = accountId;
        }

        const res = await fetchDirect(`${baseUrl.replace(/\/$/, "")}/models?client_version=${WHAM_CLIENT_VERSION}`, {
            headers,
            signal: AbortSignal.timeout(5_000),
        });

        if (!res.ok) {
            throw new Error(`WHAM /models returned ${res.status}`);
        }

        const data = (await res.json()) as WhamModelsResponse;

        return data.models.map(whamModelRecordFromApi);
    } catch (err) {
        logger.debug({ err }, "codex: live WHAM model fetch failed");
        return null;
    }
}

/**
 * Live model list from the WHAM `/models` endpoint (non-standard schema).
 * Falls back to the static catalog on any failure so callers always get a
 * usable list.
 */
export async function fetchWhamModels(
    accessToken: string,
    accountId?: string,
    baseUrl?: string
): Promise<WhamModelRecord[]> {
    const live = await tryFetchWhamModels(accessToken, accountId, baseUrl);

    if (live && live.length > 0) {
        return live;
    }

    logger.debug("codex: using static catalog fallback");
    return OPENAI_SUB_STATIC_CATALOG;
}
