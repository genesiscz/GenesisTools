import type { ModelInfo } from "@ask/types";

export enum AnthropicModelCategory {
	Haiku = "haiku",
	Sonnet = "sonnet",
	Opus = "opus",
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
	input: AnthropicModelCategory | string,
	availableModels: ModelInfo[],
): ModelSelection {
	const categories = Object.values(AnthropicModelCategory) as string[];
	const isCategory = categories.includes(input);

	if (isCategory) {
		const matches = availableModels
			.filter((m) => m.id.toLowerCase().includes(input.toLowerCase()))
			.sort((a, b) => b.id.localeCompare(a.id));

		return { request: input, strategy: "latest", model: matches[0] ?? null };
	}

	const exact =
		availableModels.find((m) => m.id === input || m.name === input) ?? null;

	return { request: input, strategy: "exact", model: exact };
}
