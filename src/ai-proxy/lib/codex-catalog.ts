import {
    type CodexModelInfo,
    type CodexModelOverride,
    mergeCodexModelRecords,
    readCodexModelsCache,
} from "@genesiscz/utils/ai/openai/codex-models";
import type { WhamModelRecord } from "@genesiscz/utils/ai/openai/sub-models";

/**
 * The proxy's view of the Codex model catalog. `server.ts` hands over `config.codexModels` on every request (the
 * same hot reload as the rest of the config), and the Codex provider asks `codexModelInfo` per request. The request
 * path adds no network call: it uses the live list only when the provider already holds one (the image guard and
 * `/v1/models` fetch it), else the Codex CLI's `models_cache.json`, else the static table.
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
