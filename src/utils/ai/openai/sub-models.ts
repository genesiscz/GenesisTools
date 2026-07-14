import { logger } from "@app/logger";
import { fetchDirect } from "@app/utils/net/fetch-direct";
import { WHAM_BASE_URL } from "./codex-auth";

export interface WhamModelRecord {
    slug: string;
    displayName: string;
    contextWindow: number;
    visibility: "list" | "hide";
    inputModalities?: string[];
    supportsParallelToolCalls?: boolean;
}

/**
 * Codex/ChatGPT (WHAM backend) models, newest first. Verified live against
 * GET wham/models (2026-07-12, plan "plus"); refresh via fetchWhamModels().
 * `gpt-5-codex` is not served on Plus but higher plans do serve it —
 * unsupported ids surface WHAM's own 400 to the caller.
 */
export const OPENAI_SUB_STATIC_CATALOG: WhamModelRecord[] = [
    { slug: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", contextWindow: 372_000, visibility: "list" },
    { slug: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", contextWindow: 372_000, visibility: "list" },
    { slug: "gpt-5.6-luna", displayName: "GPT-5.6-Luna", contextWindow: 372_000, visibility: "list" },
    { slug: "gpt-5.5", displayName: "GPT-5.5", contextWindow: 272_000, visibility: "list" },
    { slug: "gpt-5.4", displayName: "GPT-5.4", contextWindow: 272_000, visibility: "list" },
    { slug: "gpt-5.4-mini", displayName: "GPT-5.4-Mini", contextWindow: 272_000, visibility: "list" },
    { slug: "gpt-5-codex", displayName: "GPT-5-Codex", contextWindow: 272_000, visibility: "list" },
];

/** Codex model ids are already concrete; unknown values pass through unchanged. */
export function resolveOpenAiSubModel(id: string): string {
    return id;
}

const WHAM_CLIENT_VERSION = "1.0.26";

interface WhamModelsResponse {
    models: Array<{
        slug: string;
        display_name: string;
        context_window: number;
        visibility: "list" | "hide";
        input_modalities?: string[];
        supports_parallel_tool_calls?: boolean;
    }>;
}

/**
 * Live WHAM `/models` list (no fallback). Returns null on failure so callers
 * can mark availability honestly (live ok vs static skip).
 */
export async function tryFetchWhamModels(accessToken: string, accountId?: string): Promise<WhamModelRecord[] | null> {
    try {
        const headers: Record<string, string> = {
            Authorization: `Bearer ${accessToken}`,
        };

        if (accountId) {
            headers["ChatGPT-Account-Id"] = accountId;
        }

        const res = await fetchDirect(`${WHAM_BASE_URL}/models?client_version=${WHAM_CLIENT_VERSION}`, {
            headers,
            signal: AbortSignal.timeout(5_000),
        });

        if (!res.ok) {
            throw new Error(`WHAM /models returned ${res.status}`);
        }

        const data = (await res.json()) as WhamModelsResponse;

        return data.models.map((m) => ({
            slug: m.slug,
            displayName: m.display_name,
            contextWindow: m.context_window,
            visibility: m.visibility,
            inputModalities: m.input_modalities,
            supportsParallelToolCalls: m.supports_parallel_tool_calls,
        }));
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
export async function fetchWhamModels(accessToken: string, accountId?: string): Promise<WhamModelRecord[]> {
    const live = await tryFetchWhamModels(accessToken, accountId);

    if (live && live.length > 0) {
        return live;
    }

    logger.debug("codex: using static catalog fallback");
    return OPENAI_SUB_STATIC_CATALOG;
}
