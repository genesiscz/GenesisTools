import type { AiTask, AiTaskMapping, YoutubeConfigShape } from "@app/youtube/lib/config.types";

/** The slice of config the resolution needs — routes pass `await yt.config.getAll()`. */
export type AiResolutionSource = Pick<YoutubeConfigShape, "ai" | "provider">;

/** Task→legacy `provider.*` key. Legacy config had no insights/summary split — both map to `summarize`. */
const LEGACY_TASK_KEYS: Record<AiTask, keyof YoutubeConfigShape["provider"]> = {
    summary: "summarize",
    insights: "summarize",
    qa: "qa",
    transcribe: "transcribe",
    embed: "embed",
};

/** "provider" or "provider/model" — the spec-string shape `resolveProviderChoice({ fallbackSpec })` consumes. */
export function specOfAiMapping(entry: AiTaskMapping): string {
    return entry.model ? `${entry.provider}/${entry.model}` : entry.provider;
}

/**
 * Resolves the configured model spec for a task: first explicit `ai[]` entry
 * listing the task, else the first `"all"` fallback entry, else the legacy
 * `provider.<key>` string, else null (caller falls back to account defaults).
 */
export function resolveAiSpecForTask(config: AiResolutionSource, task: AiTask): string | null {
    const explicit = config.ai.find((entry) => entry.for.includes(task));

    if (explicit) {
        return specOfAiMapping(explicit);
    }

    const fallback = config.ai.find((entry) => entry.for.includes("all"));

    if (fallback) {
        return specOfAiMapping(fallback);
    }

    return config.provider[LEGACY_TASK_KEYS[task]] ?? null;
}
