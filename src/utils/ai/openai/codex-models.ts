import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import { nativeHome } from "@genesiscz/utils/providers/session-paths";
import {
    OPENAI_SUB_STATIC_CATALOG,
    type WhamApiModel,
    type WhamModelRecord,
    whamModelRecordFromApi,
} from "./sub-models";

/**
 * One place that knows, per Codex model: window, usable and compact percents, efforts, default effort, Responses
 * Lite, `comp_hash`, search support. Sources in order: the live WHAM `/models` list, the Codex CLI's own
 * `models_cache.json` (the same schema, written by the CLI), then `OPENAI_SUB_STATIC_CATALOG`. A per-model override
 * from the ai-proxy config wins over all three for the fields it names.
 *
 * Rules follow codex-rs (openai/codex 970111f6, `protocol/src/openai_models.rs` and `reasoning_effort.rs`): the
 * usable window is `effective_context_window_percent` of the window (default 95), compaction is at 90% unless the
 * record's `auto_compact_token_limit` is lower, and `ultra` is never sent: it resolves to the record's
 * `multi_agent_reasoning_effort`, else `max`, else the strongest other level. The backend refuses a literal `ultra`
 * with a 400 (probed 2026-10-25).
 */

export type CodexCatalogSource = "live" | "cache" | "static" | "default" | "override";

/** Per-model settings Martin may change in the ai-proxy config (`codexModels.<slug>`). */
export interface CodexModelOverride {
    /** Context window in tokens; replaces the catalog value. */
    window?: number;
    /** Share of the window a client may fill, in percent. */
    usablePercent?: number;
    /** Share of the window at which the client compacts, in percent. */
    compactPercent?: number;
    /** Effort used when a request names none. */
    defaultEffort?: string;
}

export const CODEX_DEFAULT_USABLE_PERCENT = 95;
export const CODEX_DEFAULT_COMPACT_PERCENT = 90;
/** codex-rs falls back to `medium` when a model lists no level at all. */
const CODEX_FALLBACK_EFFORT = "medium";

export interface CodexModelInfo {
    slug: string;
    displayName: string;
    visibility: "list" | "hide";
    window: number;
    maxContextWindow?: number;
    usablePercent: number;
    compactPercent: number;
    /** `window * usablePercent / 100`, rounded down: what `CLAUDE_CODE_MAX_CONTEXT_TOKENS` gets. */
    usableTokens: number;
    /** `window * compactPercent / 100`, lowered to the record's `auto_compact_token_limit` when that is smaller. */
    compactTokens: number;
    /** Weakest first; empty when no source lists any (an unknown model). */
    efforts: string[];
    defaultEffort?: string;
    useResponsesLite: boolean;
    compHash?: string;
    supportsSearchTool: boolean;
    webSearchToolType?: string;
    multiAgentReasoningEffort?: string;
    defaultReasoningSummary?: string;
    supportsReasoningSummaryParameter?: boolean;
    inputModalities?: string[];
    /** Which source supplied each field. */
    sources: Record<string, CodexCatalogSource>;
}

/** Where `models_cache.json` lives: the test override, else the primary `CODEX_HOME`, else `~/.codex`. */
export function codexModelsCachePath(): string {
    return env.codex.getModelsCachePathOverride() ?? join(nativeHome("codex"), "models_cache.json");
}

let cacheMemo: { path: string; mtimeMs: number; records: WhamModelRecord[] } | null = null;

/**
 * Read the Codex CLI's model cache (read-only; the CLI owns the file). Memoised by path and mtime, so a request
 * path may call it on every request. Missing or unreadable answers an empty list.
 */
export function readCodexModelsCache(path = codexModelsCachePath()): WhamModelRecord[] {
    let mtimeMs: number;
    try {
        mtimeMs = statSync(path).mtimeMs;
    } catch (err) {
        logger.debug({ err, path }, "codex-models: no Codex CLI model cache");
        return [];
    }

    if (cacheMemo && cacheMemo.path === path && cacheMemo.mtimeMs === mtimeMs) {
        return cacheMemo.records;
    }

    let records: WhamModelRecord[] = [];
    try {
        const parsed = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
        const models = isObject(parsed) && Array.isArray(parsed.models) ? parsed.models : [];
        records = models.filter(isApiModel).map(whamModelRecordFromApi);
    } catch (err) {
        logger.warn({ err, path }, "codex-models: Codex CLI model cache is unreadable; using the other sources");
    }

    cacheMemo = { path, mtimeMs, records };
    return records;
}

function isApiModel(value: unknown): value is WhamApiModel {
    return (
        isObject(value) &&
        typeof value.slug === "string" &&
        typeof value.display_name === "string" &&
        typeof value.context_window === "number"
    );
}

type Layer = { source: CodexCatalogSource; record: WhamModelRecord | undefined };

/** The first layer whose record has the field set, and which layer that was. */
function pick<K extends keyof WhamModelRecord>(
    layers: Layer[],
    key: K
): { value: WhamModelRecord[K]; source: CodexCatalogSource } | undefined {
    for (const layer of layers) {
        const value = layer.record?.[key];

        if (value !== undefined) {
            return { value, source: layer.source };
        }
    }

    return undefined;
}

/**
 * Merge the three sources into one record per slug, field by field (live, then cache, then static), and apply the
 * overrides. Pure: callers pass every source, so tests need no files and no network.
 */
export function mergeCodexModelRecords({
    live,
    cache,
    fallback = OPENAI_SUB_STATIC_CATALOG,
    overrides = {},
}: {
    live?: WhamModelRecord[] | null;
    cache?: WhamModelRecord[];
    fallback?: WhamModelRecord[];
    overrides?: Record<string, CodexModelOverride>;
}): Map<string, CodexModelInfo> {
    const bySlug = (records: WhamModelRecord[] | null | undefined) =>
        new Map((records ?? []).map((record) => [record.slug, record]));
    const liveMap = bySlug(live);
    const cacheMap = bySlug(cache);
    const staticMap = bySlug(fallback);
    const slugs = [...new Set([...liveMap.keys(), ...cacheMap.keys(), ...staticMap.keys()])];
    const result = new Map<string, CodexModelInfo>();

    for (const slug of slugs) {
        const layers: Layer[] = [
            { source: "live", record: liveMap.get(slug) },
            { source: "cache", record: cacheMap.get(slug) },
            { source: "static", record: staticMap.get(slug) },
        ];
        const sources: Record<string, CodexCatalogSource> = {};
        const take = <K extends keyof WhamModelRecord>(key: K, name: string = key) => {
            const found = pick(layers, key);

            if (found) {
                sources[name] = found.source;
            }

            return found?.value;
        };

        const override = overrides[slug] ?? {};
        const catalogWindow = take("contextWindow", "window") ?? 0;
        const window = override.window ?? catalogWindow;

        if (override.window !== undefined) {
            sources.window = "override";
        }

        const catalogPercent = take("effectiveContextWindowPercent", "usablePercent");
        const usablePercent = override.usablePercent ?? catalogPercent ?? CODEX_DEFAULT_USABLE_PERCENT;
        sources.usablePercent =
            override.usablePercent !== undefined ? "override" : (sources.usablePercent ?? "default");
        const compactPercent = override.compactPercent ?? CODEX_DEFAULT_COMPACT_PERCENT;
        sources.compactPercent = override.compactPercent !== undefined ? "override" : "default";
        const autoCompactTokenLimit = take("autoCompactTokenLimit");
        const byPercent = Math.floor((window * compactPercent) / 100);
        const efforts = take("supportedEfforts", "efforts") ?? [];
        const catalogDefault = take("defaultEffort");
        const defaultEffort = override.defaultEffort ?? catalogDefault;

        if (override.defaultEffort !== undefined) {
            sources.defaultEffort = "override";
        }

        result.set(slug, {
            slug,
            displayName: take("displayName") ?? slug,
            visibility: take("visibility") ?? "list",
            window,
            maxContextWindow: take("maxContextWindow"),
            usablePercent,
            compactPercent,
            usableTokens: Math.floor((window * usablePercent) / 100),
            compactTokens: autoCompactTokenLimit !== undefined ? Math.min(byPercent, autoCompactTokenLimit) : byPercent,
            efforts,
            defaultEffort,
            useResponsesLite: take("useResponsesLite") ?? false,
            compHash: take("compHash"),
            supportsSearchTool: take("supportsSearchTool") ?? false,
            webSearchToolType: take("webSearchToolType"),
            multiAgentReasoningEffort: take("multiAgentReasoningEffort"),
            defaultReasoningSummary: take("defaultReasoningSummary"),
            supportsReasoningSummaryParameter: take("supportsReasoningSummaryParameter"),
            inputModalities: take("inputModalities"),
            sources,
        });
    }

    return result;
}

export type CodexEffortResolution =
    | { ok: true; effort: string; mappedFrom?: string }
    | { ok: false; message: string; allowed: string[] };

/** "low, medium, high, xhigh, max, ultra (runs as xhigh)" for messages and help text. */
export function describeCodexEfforts(model: Pick<CodexModelInfo, "efforts" | "multiAgentReasoningEffort">): string {
    return model.efforts
        .map((effort) => {
            if (effort !== "ultra") {
                return effort;
            }

            return `ultra (runs as ${resolveUltra(model)})`;
        })
        .join(", ");
}

/** codex-rs `resolve_reasoning_effort` for `Ultra`. */
function resolveUltra(model: Pick<CodexModelInfo, "efforts" | "multiAgentReasoningEffort">): string {
    const multiAgent = model.multiAgentReasoningEffort;

    if (multiAgent && multiAgent !== "ultra" && model.efforts.includes(multiAgent)) {
        return multiAgent;
    }

    if (model.efforts.includes("max")) {
        return "max";
    }

    return model.efforts.filter((effort) => effort !== "ultra").at(-1) ?? CODEX_FALLBACK_EFFORT;
}

/**
 * Check a requested effort against the model's own list. A listed effort passes unchanged (`max` stays `max`);
 * `ultra` resolves the way codex-rs does and says so in `mappedFrom`; anything else is refused with the list.
 */
export function resolveCodexEffort(
    model: Pick<CodexModelInfo, "slug" | "efforts" | "multiAgentReasoningEffort">,
    requested: string
): CodexEffortResolution {
    const effort = requested.trim().toLowerCase();

    if (!model.efforts.includes(effort)) {
        return {
            ok: false,
            allowed: model.efforts,
            message: `${model.slug} has no reasoning effort "${requested}". Allowed: ${describeCodexEfforts(model)}.`,
        };
    }

    if (effort !== "ultra") {
        return { ok: true, effort };
    }

    return { ok: true, effort: resolveUltra(model), mappedFrom: "ultra" };
}
