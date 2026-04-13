import { describe, expect, it } from "bun:test";
import type { ModelInfo } from "@ask/types";
import { AnthropicModelCategory, OpenAIModelCategory, resolveModel } from "../ModelResolver";

const MOCK_MODELS: ModelInfo[] = [
    {
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        contextWindow: 200000,
        capabilities: ["chat"],
        provider: "anthropic",
        category: "haiku",
    },
    {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        contextWindow: 200000,
        capabilities: ["chat", "vision"],
        provider: "anthropic",
        category: "sonnet",
    },
    {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        contextWindow: 200000,
        capabilities: ["chat", "vision", "reasoning"],
        provider: "anthropic",
        category: "opus",
    },
    {
        id: "gpt-4o",
        name: "GPT-4o",
        contextWindow: 128000,
        capabilities: ["chat"],
        provider: "openai",
        category: "standard",
    },
    {
        id: "gpt-4o-mini",
        name: "GPT-4o Mini",
        contextWindow: 128000,
        capabilities: ["chat"],
        provider: "openai",
        category: "mini",
    },
];

describe("ModelResolver", () => {
    describe("AnthropicModelCategory enum", () => {
        it("has haiku, sonnet, opus values", () => {
            expect(AnthropicModelCategory.Haiku).toBe(AnthropicModelCategory.Haiku);
            expect(AnthropicModelCategory.Sonnet).toBe(AnthropicModelCategory.Sonnet);
            expect(AnthropicModelCategory.Opus).toBe(AnthropicModelCategory.Opus);
            // Verify actual string values
            const values: string[] = Object.values(AnthropicModelCategory);
            expect(values).toContain("haiku");
            expect(values).toContain("sonnet");
            expect(values).toContain("opus");
        });
    });

    describe("OpenAIModelCategory enum", () => {
        it("has mini and standard values", () => {
            const values: string[] = Object.values(OpenAIModelCategory);
            expect(values).toContain("mini");
            expect(values).toContain("standard");
        });
    });

    describe("resolveModel() with Anthropic categories", () => {
        it("resolves haiku category", () => {
            const result = resolveModel(AnthropicModelCategory.Haiku, MOCK_MODELS);
            expect(result.strategy).toBe("latest");
            expect(result.model?.id).toBe("claude-haiku-4-5");
        });

        it("resolves sonnet category", () => {
            const result = resolveModel(AnthropicModelCategory.Sonnet, MOCK_MODELS);
            expect(result.strategy).toBe("latest");
            expect(result.model?.id).toBe("claude-sonnet-4-6");
        });

        it("resolves opus category", () => {
            const result = resolveModel(AnthropicModelCategory.Opus, MOCK_MODELS);
            expect(result.strategy).toBe("latest");
            expect(result.model?.id).toBe("claude-opus-4-6");
        });
    });

    describe("resolveModel() with OpenAI categories", () => {
        it("resolves mini category to gpt-4o-mini", () => {
            const result = resolveModel(OpenAIModelCategory.Mini, MOCK_MODELS);
            expect(result.strategy).toBe("latest");
            expect(result.model?.id).toBe("gpt-4o-mini");
        });

        it("resolves standard category to gpt-4o via category field", () => {
            const result = resolveModel(OpenAIModelCategory.Standard, MOCK_MODELS);
            expect(result.strategy).toBe("latest");
            expect(result.model?.id).toBe("gpt-4o");
        });
    });

    describe("resolveModel() category field vs substring fallback", () => {
        it("uses category field when available", () => {
            const models: ModelInfo[] = [
                {
                    id: "gpt-5",
                    name: "GPT-5",
                    contextWindow: 200000,
                    capabilities: ["chat"],
                    provider: "openai",
                    category: "standard",
                },
                {
                    id: "gpt-4o",
                    name: "GPT-4o",
                    contextWindow: 128000,
                    capabilities: ["chat"],
                    provider: "openai",
                    category: "standard",
                },
            ];
            const result = resolveModel(OpenAIModelCategory.Standard, models);
            expect(result.strategy).toBe("latest");
            expect(result.model?.id).toBe("gpt-5");
        });

        it("falls back to substring matching when category field missing", () => {
            const models: ModelInfo[] = [
                {
                    id: "claude-haiku-4-5",
                    name: "Claude Haiku 4.5",
                    contextWindow: 200000,
                    capabilities: ["chat"],
                    provider: "anthropic",
                },
            ];
            const result = resolveModel(AnthropicModelCategory.Haiku, models);
            expect(result.model?.id).toBe("claude-haiku-4-5");
        });
    });

    describe("resolveModel() with exact model ID", () => {
        it("finds exact match by ID", () => {
            const result = resolveModel("claude-sonnet-4-6", MOCK_MODELS);
            expect(result.strategy).toBe("exact");
            expect(result.model?.id).toBe("claude-sonnet-4-6");
        });

        it("finds exact match by name", () => {
            const result = resolveModel("Claude Opus 4.6", MOCK_MODELS);
            expect(result.strategy).toBe("exact");
            expect(result.model?.id).toBe("claude-opus-4-6");
        });

        it("returns null for non-existent model", () => {
            const result = resolveModel("gpt-nonexistent", MOCK_MODELS);
            expect(result.strategy).toBe("exact");
            expect(result.model).toBeNull();
        });
    });

    describe("resolveModel() with empty model list", () => {
        it("returns null for category", () => {
            const result = resolveModel(AnthropicModelCategory.Haiku, []);
            expect(result.model).toBeNull();
        });

        it("returns null for exact ID", () => {
            const result = resolveModel("claude-haiku-4-5", []);
            expect(result.model).toBeNull();
        });
    });

    describe("resolveModel() category picks latest by lexicographic sort", () => {
        it("picks higher versioned model when multiple match", () => {
            const models: ModelInfo[] = [
                {
                    id: "claude-sonnet-4-5",
                    name: "Sonnet 4.5",
                    contextWindow: 200000,
                    capabilities: ["chat"],
                    provider: "anthropic",
                },
                {
                    id: "claude-sonnet-4-6",
                    name: "Sonnet 4.6",
                    contextWindow: 200000,
                    capabilities: ["chat"],
                    provider: "anthropic",
                },
            ];
            const result = resolveModel("sonnet", models);
            expect(result.model?.id).toBe("claude-sonnet-4-6"); // 4-6 > 4-5 lexicographically
        });
    });
});
