import type { AiProxyConfig } from "@app/ai-proxy/lib/types";
import {
    type CodexModelInfo,
    type CodexModelOverride,
    mergeCodexModelRecords,
    readCodexModelsCache,
} from "@genesiscz/utils/ai/openai/codex-models";
import type { WhamModelRecord } from "@genesiscz/utils/ai/openai/sub-models";
import { deepMerge } from "@genesiscz/utils/object";

/**
 * The Codex model overrides of a proxy config (`modelOverrides.codex`). A config object that never went through the
 * loader can still hold the old `codexModels`; it is read with the same rule as the migration: the new key wins field
 * by field, the old one fills gaps.
 */
export function codexModelOverrides(
    config: Pick<AiProxyConfig, "modelOverrides" | "codexModels">
): Record<string, CodexModelOverride> {
    return deepMerge(config.codexModels ?? {}, config.modelOverrides?.codex ?? {});
}

/**
 * The proxy's view of the Codex model catalog. `server.ts` hands over `codexModelOverrides(config)` on every request
 * (the same hot reload as the rest of the config), and the Codex provider asks `codexModelInfo` per request. The
 * request path adds no network call: it uses the live list only when the provider already holds one (the image guard
 * and `/v1/models` fetch it), else the Codex CLI's `models_cache.json`, else the static table.
 */
let overrides: Record<string, CodexModelOverride> = {};

export function setCodexModelOverrides(next: Record<string, CodexModelOverride> | undefined): void {
    overrides = next ?? {};
}

export function codexModelInfo(slug: string, live: WhamModelRecord[] | null): CodexModelInfo | undefined {
    return mergeCodexModelRecords({ live, cache: readCodexModelsCache(), overrides }).get(slug);
}

/** The models the catalog lists (`visibility: "list"`), for a session's `/model` picker. */
export function listedCodexModels(): CodexModelInfo[] {
    return [...mergeCodexModelRecords({ cache: readCodexModelsCache(), overrides }).values()].filter(
        (model) => model.visibility === "list"
    );
}
