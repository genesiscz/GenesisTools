import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { z } from "zod";

const generateObjectMock = mock();

mock.module("ai", () => ({
    generateObject: (...args: unknown[]) => generateObjectMock(...args),
    generateText: () => {
        throw new Error("generateText should not be called by callLLMStructured");
    },
    streamText: () => {
        throw new Error("streamText should not be called by callLLMStructured");
    },
}));

const fakeProviderChoice = {
    provider: { name: "fakeprov", type: "openai", provider: "openai", systemPromptPrefix: undefined },
    model: { id: "fake-model" },
} as unknown as Parameters<typeof import("@app/utils/ai/call-llm").callLLMStructured>[0]["providerChoice"];

mock.module("@ask/types/provider", () => ({
    getLanguageModel: () => "MOCK_MODEL",
}));

mock.module("@app/utils/claude/subscription-billing", () => ({
    applySystemPromptPrefix: (_prefix: string | undefined, system: string) => system,
}));

mock.module("@app/utils/ai/prompt-caching", () => ({
    buildProviderOptions: () => ({}),
}));

beforeEach(() => {
    generateObjectMock.mockReset();
});

afterEach(() => {
    generateObjectMock.mockReset();
});

describe("callLLMStructured", () => {
    it("returns the typed object, JSON-stringified content, and usage", async () => {
        const { callLLMStructured } = await import("@app/utils/ai/call-llm");
        generateObjectMock.mockResolvedValueOnce({
            object: { tldr: "hello", points: ["a", "b"] },
            usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        });

        const schema = z.object({
            tldr: z.string(),
            points: z.array(z.string()),
        });
        const result = await callLLMStructured({
            systemPrompt: "you summarise",
            userPrompt: "go",
            providerChoice: fakeProviderChoice,
            schema,
        });

        expect(result.object).toEqual({ tldr: "hello", points: ["a", "b"] });
        expect(result.content).toBe(SafeJSON.stringify({ tldr: "hello", points: ["a", "b"] }, null, 2));
        expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
        expect(generateObjectMock).toHaveBeenCalledTimes(1);
        const args = generateObjectMock.mock.calls[0][0] as Record<string, unknown>;
        expect(args.system).toBe("you summarise");
        expect(args.prompt).toBe("go");
        expect(args.schema).toBe(schema);
    });

    it("propagates the AI SDK error", async () => {
        const { callLLMStructured } = await import("@app/utils/ai/call-llm");
        generateObjectMock.mockRejectedValueOnce(new Error("schema mismatch"));

        await expect(
            callLLMStructured({
                systemPrompt: "x",
                userPrompt: "y",
                providerChoice: fakeProviderChoice,
                schema: z.object({ a: z.string() }),
            })
        ).rejects.toThrow("schema mismatch");
    });
});
