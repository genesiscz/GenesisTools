import type { ModelInfo } from "@ask/types";

export enum AnthropicModelCategory {
    Haiku = "haiku",
    Sonnet = "sonnet",
    Opus = "opus",
}

export enum OpenAIModelCategory {
    Mini = "mini", // gpt-4o-mini
    Standard = "standard", // gpt-4o, gpt-5
}

export interface ModelSelection {
    /** The category or raw model ID that was requested */
    request: string;
    /** Resolution strategy used */
    strategy: "latest" | "exact";
    /** Resolved model, or null if no match */
    model: ModelInfo | null;
}

/**
 * Resolve a model from a list of available models.
 * Pure function — no I/O, no config access.
 *
 * @param input - AnthropicModelCategory enum value or raw model ID
 * @param availableModels - Models from a specific provider/account
 */
export function resolveModel(
    input: AnthropicModelCategory | OpenAIModelCategory | string,
    availableModels: ModelInfo[]
): ModelSelection {
    const categories = [...Object.values(AnthropicModelCategory), ...Object.values(OpenAIModelCategory)] as string[];
    const isCategory = categories.includes(input);

    if (isCategory) {
        const inputLower = input.toLowerCase();

        // Primary: match on explicit category field
        let matches = availableModels.filter((m) => m.category?.toLowerCase() === inputLower);

        // Fallback: substring match on model ID (e.g., "haiku" in "claude-haiku-4-5")
        if (matches.length === 0) {
            matches = availableModels.filter((m) => m.id.toLowerCase().includes(inputLower));
        }

        matches.sort((a, b) => b.id.localeCompare(a.id));

        return { request: input, strategy: "latest", model: matches[0] ?? null };
    }

    const exact = availableModels.find((m) => m.id === input || m.name === input) ?? null;

    return { request: input, strategy: "exact", model: exact };
}
