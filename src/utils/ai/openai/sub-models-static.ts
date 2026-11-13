export interface WhamModelRecord {
    slug: string;
    displayName: string;
    contextWindow: number;
    visibility: "list" | "hide";
    inputModalities?: string[];
    supportsParallelToolCalls?: boolean;
    /** `supported_reasoning_levels[].effort`, weakest first, as the backend lists them. */
    supportedEfforts?: string[];
    /** `default_reasoning_level`: the effort Codex sends when the user picked none. */
    defaultEffort?: string;
    /** `effective_context_window_percent`: the share of the window a client may fill (codex-rs default 95). */
    effectiveContextWindowPercent?: number;
    /** `max_context_window`: the largest window a config override may ask for. */
    maxContextWindow?: number;
    /** `auto_compact_token_limit`: a catalog compaction limit that may only LOWER codex-rs's 90%. */
    autoCompactTokenLimit?: number;
    /** `use_responses_lite`: codex-rs sends Lite-only fields (`reasoning.context: "all_turns"`) for these. */
    useResponsesLite?: boolean;
    /** `comp_hash`: models that share it can read each other's encrypted items. */
    compHash?: string;
    supportsSearchTool?: boolean;
    webSearchToolType?: string;
    /** `multi_agent_reasoning_effort`: what `ultra` resolves to (codex-rs `resolve_reasoning_effort`). */
    multiAgentReasoningEffort?: string;
    defaultReasoningSummary?: string;
    supportsReasoningSummaryParameter?: boolean;
}

/**
 * The GPT-6 and GPT-5.6 records as the live WHAM `/models` list gave them on 2026-10-25 21:24 (account plan Pro):
 * efforts low to max (plus `ultra` where `ultra` is set), 95% usable window, `max_context_window` 872000,
 * Responses Lite, `comp_hash` "3000", the native search tool. `ultra: "xhigh"` is the record's
 * `multi_agent_reasoning_effort`. The live list and `~/.codex/models_cache.json` win over these (codex-models.ts).
 */
function gpt6(
    slug: string,
    displayName: string,
    contextWindow: number,
    options: { defaultEffort: string; ultra?: true | string }
): WhamModelRecord {
    return {
        slug,
        displayName,
        contextWindow,
        visibility: "list",
        inputModalities: ["text", "image"],
        supportedEfforts: ["low", "medium", "high", "xhigh", "max", ...(options.ultra ? ["ultra"] : [])],
        defaultEffort: options.defaultEffort,
        effectiveContextWindowPercent: 95,
        maxContextWindow: 872_000,
        useResponsesLite: true,
        compHash: "3000",
        supportsSearchTool: true,
        webSearchToolType: "text_and_image",
        multiAgentReasoningEffort: typeof options.ultra === "string" ? options.ultra : undefined,
        defaultReasoningSummary: "none",
    };
}

/**
 * Codex/ChatGPT (WHAM backend) models, newest first. Verified live against
 * GET wham/models (2026-07-12, plan "plus"); Astra's default context window
 * verified from the native Codex model catalogue on 2026-09-07. The GPT-6 and GPT-5.6 windows were
 * re-read from the native Codex cache (`~/.codex/models_cache.json`) on 2026-10-13: 6.1 Sol has 500K,
 * the others 272K. GPT-6.1 Terra (500K, default effort low) was read from the same cache on 2026-10-27.
 * Refresh via fetchWhamModels().
 * `gpt-5.4*` and `gpt-5-codex` were absent from that list, but higher plans may still serve them —
 * unsupported ids surface WHAM's own 400 to the caller.
 */
export const OPENAI_SUB_STATIC_CATALOG: WhamModelRecord[] = [
    gpt6("gpt-6-astra", "GPT-6-Astra", 272_000, { defaultEffort: "medium", ultra: "xhigh" }),
    gpt6("gpt-6.1-sol", "GPT-6.1-Sol", 500_000, { defaultEffort: "low", ultra: "xhigh" }),
    gpt6("gpt-6.1-terra", "GPT-6.1 Terra", 500_000, { defaultEffort: "low", ultra: "xhigh" }),
    gpt6("gpt-6-sol", "GPT-6-Sol", 272_000, { defaultEffort: "medium", ultra: true }),
    gpt6("gpt-6-luna", "GPT-6-Luna", 272_000, { defaultEffort: "medium" }),
    gpt6("gpt-5.6-sol", "GPT-5.6-Sol", 272_000, { defaultEffort: "low", ultra: true }),
    gpt6("gpt-5.6-terra", "GPT-5.6-Terra", 272_000, { defaultEffort: "medium", ultra: true }),
    gpt6("gpt-5.6-luna", "GPT-5.6-Luna", 272_000, { defaultEffort: "medium" }),
    { slug: "gpt-5.5", displayName: "GPT-5.5", contextWindow: 272_000, visibility: "list" },
    { slug: "gpt-5.4", displayName: "GPT-5.4", contextWindow: 272_000, visibility: "list" },
    { slug: "gpt-5.4-mini", displayName: "GPT-5.4-Mini", contextWindow: 272_000, visibility: "list" },
    { slug: "gpt-5-codex", displayName: "GPT-5-Codex", contextWindow: 272_000, visibility: "list" },
];
