import { aliasMapFor, byId, byProvider, inputModalitiesFor } from "@genesiscz/utils/ai/catalog";
import { logger } from "@genesiscz/utils/logger";
import { fetchDirect } from "@genesiscz/utils/net/fetch-direct";

export interface AnthropicSubModelRecord {
    id: string;
    displayName: string;
    contextWindow: number;
    thinking: "reasoning" | "none";
    inputModalities?: string[];
}

/**
 * Claude models served to subscription (OAuth) tokens, newest first — derived
 * from the curated registry (`@genesiscz/utils/ai/catalog`). Add new
 * models there, not here.
 */
export const ANTHROPIC_SUB_STATIC_CATALOG: AnthropicSubModelRecord[] = byProvider("anthropic").map((model) => ({
    id: model.id,
    displayName: model.displayName,
    contextWindow: model.contextWindow,
    thinking: model.thinking === "none" ? "none" : "reasoning",
    inputModalities: inputModalitiesFor(model),
}));

/**
 * Short aliases advertised alongside the concrete ids — always tracking the
 * newest model of each family. The bare `claude-haiku-4-5` is NOT served by
 * the API; the dated id is required.
 */
export const ANTHROPIC_SUB_ALIASES = ["sonnet", "opus", "haiku", "fable"] as const;

export type AnthropicSubAlias = (typeof ANTHROPIC_SUB_ALIASES)[number];

const ANTHROPIC_SUB_ALIAS_MAP = aliasMapFor("anthropic");

/**
 * Resolve an alias to its concrete Anthropic model id. Unknown values pass
 * through unchanged so a caller can also request a concrete id directly.
 */
export function resolveAnthropicSubModel(alias: string): string {
    return ANTHROPIC_SUB_ALIAS_MAP[alias] ?? alias;
}

/**
 * The models list endpoint returns no context size — take it from the registry,
 * falling back to a family pattern for ids the registry does not carry yet
 * (dated variants, models newer than the catalog).
 */
export function inferAnthropicContextWindow(id: string): number {
    const known = byId(id);

    if (known) {
        return known.contextWindow;
    }

    return /sonnet-5|fable-5|opus-5|opus-4-[678]|sonnet-4-6/.test(id) ? 1_000_000 : 200_000;
}

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * What a Messages request may carry for a given model. The API answers a
 * forbidden field with a 400, so a translator must ask before it emits one.
 */
export interface AnthropicRequestRules {
    /** "adaptive" takes `thinking: {type: "adaptive"}` + `output_config.effort`; "budget" takes `budget_tokens`. */
    thinking: "adaptive" | "budget";
    /** `temperature` / `top_p` are accepted (removed from Opus 4.7 on). */
    sampling: boolean;
    /** `tool_choice` `any` / `tool` are accepted (removed on Opus 5.5 and Fable 5.1). */
    forcedToolChoice: boolean;
    /** A trailing assistant turn (prefill) is accepted (removed from Opus 4.6 / Sonnet 4.6 on). */
    prefill: boolean;
    /** Highest effort below `max` the model knows; `xhigh` arrived with Opus 4.7. */
    effortCeiling: "high" | "xhigh";
}

function claudeVersion(id: string): { family: string; version: number } | null {
    // `claude-opus-5-5` → 5.5, `claude-haiku-4-5-20251001` → 4.5, `claude-opus-4-20250514` → 4.
    const match = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(id);

    if (!match) {
        return null;
    }

    return { family: match[1], version: Number(match[2]) + (match[3] ? Number(match[3]) / 10 : 0) };
}

export function anthropicRequestRules(id: string): AnthropicRequestRules {
    const parsed = claudeVersion(id);

    if (!parsed || parsed.family === "haiku") {
        return { thinking: "budget", sampling: true, forcedToolChoice: true, prefill: true, effortCeiling: "high" };
    }

    const { family, version } = parsed;
    const fableTier = family === "fable" || family === "mythos";

    return {
        thinking: fableTier || version >= 4.6 ? "adaptive" : "budget",
        sampling: !fableTier && version < 4.7,
        forcedToolChoice: fableTier ? version < 5.1 : !(family === "opus" && version >= 5.5),
        prefill: !fableTier && version < 4.6,
        effortCeiling: fableTier || version >= 4.7 ? "xhigh" : "high",
    };
}

interface AnthropicModelsResponse {
    data: Array<{ id: string; display_name: string }>;
}

/**
 * Live model list for a subscription OAuth token (no fallback).
 * Returns null when the request fails so callers can distinguish live vs static.
 */
export async function tryFetchAnthropicSubModels(token: string): Promise<AnthropicSubModelRecord[] | null> {
    try {
        const res = await fetchDirect("https://api.anthropic.com/v1/models?limit=100", {
            headers: {
                Authorization: `Bearer ${token}`,
                "anthropic-version": "2023-06-01",
                "anthropic-beta": "oauth-2025-04-20",
            },
            signal: AbortSignal.timeout(5_000),
        });

        if (!res.ok) {
            throw new Error(`GET /v1/models returned ${res.status}`);
        }

        const data = (await res.json()) as AnthropicModelsResponse;

        return data.data.map((m) => ({
            id: m.id,
            displayName: m.display_name,
            contextWindow: inferAnthropicContextWindow(m.id),
            thinking: m.id.includes("haiku") ? "none" : "reasoning",
        }));
    } catch (err) {
        logger.debug({ err }, "anthropic: live model fetch failed");
        return null;
    }
}

/**
 * Live model list for a subscription OAuth token. Falls back to the static
 * catalog on any failure so callers always get a usable list.
 */
export async function fetchAnthropicSubModels(token: string): Promise<AnthropicSubModelRecord[]> {
    const live = await tryFetchAnthropicSubModels(token);

    if (live && live.length > 0) {
        return live;
    }

    logger.debug("anthropic: using static catalog fallback");
    return ANTHROPIC_SUB_STATIC_CATALOG;
}
