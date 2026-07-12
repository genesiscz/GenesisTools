import { logger } from "@app/logger";

export interface AnthropicSubModelRecord {
    id: string;
    displayName: string;
    contextWindow: number;
    thinking: "reasoning" | "none";
}

/**
 * Claude models served to subscription (OAuth) tokens, newest first. Verified
 * live against GET api.anthropic.com/v1/models (2026-07-12); refresh via
 * fetchAnthropicSubModels() when Anthropic ships a new family.
 */
export const ANTHROPIC_SUB_STATIC_CATALOG: AnthropicSubModelRecord[] = [
    { id: "claude-sonnet-5", displayName: "Claude Sonnet 5", contextWindow: 1_000_000, thinking: "reasoning" },
    { id: "claude-fable-5", displayName: "Claude Fable 5", contextWindow: 1_000_000, thinking: "reasoning" },
    { id: "claude-opus-4-8", displayName: "Claude Opus 4.8", contextWindow: 1_000_000, thinking: "reasoning" },
    { id: "claude-opus-4-7", displayName: "Claude Opus 4.7", contextWindow: 1_000_000, thinking: "reasoning" },
    { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", contextWindow: 1_000_000, thinking: "reasoning" },
    { id: "claude-opus-4-6", displayName: "Claude Opus 4.6", contextWindow: 1_000_000, thinking: "reasoning" },
    { id: "claude-opus-4-5-20251101", displayName: "Claude Opus 4.5", contextWindow: 200_000, thinking: "reasoning" },
    { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5", contextWindow: 200_000, thinking: "none" },
    {
        id: "claude-sonnet-4-5-20250929",
        displayName: "Claude Sonnet 4.5",
        contextWindow: 200_000,
        thinking: "reasoning",
    },
    { id: "claude-opus-4-1-20250805", displayName: "Claude Opus 4.1", contextWindow: 200_000, thinking: "reasoning" },
];

/**
 * Short aliases advertised alongside the concrete ids — always tracking the
 * newest model of each family. The bare `claude-haiku-4-5` is NOT served by
 * the API; the dated id is required.
 */
export const ANTHROPIC_SUB_ALIASES = ["sonnet", "opus", "haiku", "fable"] as const;

export type AnthropicSubAlias = (typeof ANTHROPIC_SUB_ALIASES)[number];

const ANTHROPIC_SUB_ALIAS_MAP: Record<AnthropicSubAlias, string> = {
    sonnet: "claude-sonnet-5",
    opus: "claude-opus-4-8",
    haiku: "claude-haiku-4-5-20251001",
    fable: "claude-fable-5",
};

/**
 * Resolve an alias to its concrete Anthropic model id. Unknown values pass
 * through unchanged so a caller can also request a concrete id directly.
 */
export function resolveAnthropicSubModel(alias: string): string {
    return ANTHROPIC_SUB_ALIAS_MAP[alias as AnthropicSubAlias] ?? alias;
}

/** The models list endpoint returns no context size — infer from the family. */
export function inferAnthropicContextWindow(id: string): number {
    return /sonnet-5|fable-5|opus-4-[678]|sonnet-4-6/.test(id) ? 1_000_000 : 200_000;
}

interface AnthropicModelsResponse {
    data: Array<{ id: string; display_name: string }>;
}

/**
 * Live model list for a subscription OAuth token. Falls back to the static
 * catalog on any failure so callers always get a usable list.
 */
export async function fetchAnthropicSubModels(token: string): Promise<AnthropicSubModelRecord[]> {
    try {
        const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
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
        logger.debug({ err }, "anthropic: live model fetch failed, using static catalog");
        return ANTHROPIC_SUB_STATIC_CATALOG;
    }
}
