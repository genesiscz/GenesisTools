import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { toLanguageModelUsage } from "@ask/utils/helpers";
import { z } from "zod";

const generateObjectMock = mock();
const streamObjectMock = mock();

mock.module("ai", () => ({
    generateObject: (...args: unknown[]) => generateObjectMock(...args),
    streamObject: (...args: unknown[]) => streamObjectMock(...args),
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
    streamObjectMock.mockReset();
});

afterEach(() => {
    generateObjectMock.mockReset();
    streamObjectMock.mockReset();
});

async function* partialsOf(...values: unknown[]): AsyncGenerator<unknown> {
    for (const value of values) {
        yield value;
    }
}

describe("callLLMStructured", () => {
    it("returns the typed object, JSON-stringified content, and usage", async () => {
        const { callLLMStructured } = await import("@app/utils/ai/call-llm");
        const fakeUsage = toLanguageModelUsage({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
        generateObjectMock.mockResolvedValueOnce({
            object: { tldr: "hello", points: ["a", "b"] },
            usage: fakeUsage,
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
        expect(result.usage).toEqual(fakeUsage);
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

    it("streams partials through onPartial and resolves the final object", async () => {
        const { callLLMStructured } = await import("@app/utils/ai/call-llm");
        const fakeUsage = toLanguageModelUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
        streamObjectMock.mockReturnValueOnce({
            partialObjectStream: partialsOf({ tldr: "he" }, { tldr: "hello" }),
            object: Promise.resolve({ tldr: "hello" }),
            usage: Promise.resolve(fakeUsage),
        });

        const partials: unknown[] = [];
        const result = await callLLMStructured({
            systemPrompt: "x",
            userPrompt: "y",
            providerChoice: fakeProviderChoice,
            schema: z.object({ tldr: z.string() }),
            onPartial: (partial) => partials.push(partial),
        });

        expect(partials).toEqual([{ tldr: "he" }, { tldr: "hello" }]);
        expect(result.object).toEqual({ tldr: "hello" });
        expect(result.usage).toEqual(fakeUsage);
        expect(generateObjectMock).not.toHaveBeenCalled();
    });

    it("falls back to generateObject when streaming fails before the first chunk", async () => {
        const { callLLMStructured } = await import("@app/utils/ai/call-llm");
        streamObjectMock.mockImplementationOnce(() => {
            throw new Error("streaming unsupported");
        });
        generateObjectMock.mockResolvedValueOnce({ object: { tldr: "fallback" }, usage: undefined });

        const partials: unknown[] = [];
        const result = await callLLMStructured({
            systemPrompt: "x",
            userPrompt: "y",
            providerChoice: fakeProviderChoice,
            schema: z.object({ tldr: z.string() }),
            onPartial: (partial) => partials.push(partial),
        });

        expect(partials).toEqual([]);
        expect(result.object).toEqual({ tldr: "fallback" });
        expect(generateObjectMock).toHaveBeenCalledTimes(1);
    });

    it("propagates a mid-stream error after the first chunk (no fallback)", async () => {
        const { callLLMStructured } = await import("@app/utils/ai/call-llm");
        async function* failingStream(): AsyncGenerator<unknown> {
            yield { tldr: "he" };
            throw new Error("stream died");
        }

        const rejectedObject = Promise.reject(new Error("stream died"));
        const rejectedUsage = Promise.reject(new Error("stream died"));
        rejectedObject.catch(() => {});
        rejectedUsage.catch(() => {});
        streamObjectMock.mockReturnValueOnce({
            partialObjectStream: failingStream(),
            object: rejectedObject,
            usage: rejectedUsage,
        });

        await expect(
            callLLMStructured({
                systemPrompt: "x",
                userPrompt: "y",
                providerChoice: fakeProviderChoice,
                schema: z.object({ tldr: z.string() }),
                onPartial: () => {},
            })
        ).rejects.toThrow("stream died");
        expect(generateObjectMock).not.toHaveBeenCalled();
    });
});
