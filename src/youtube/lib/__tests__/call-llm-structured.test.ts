import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { toLanguageModelUsage } from "@genesiscz/utils/ask/usage-tokens";
import { SafeJSON } from "@genesiscz/utils/json";
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
    // Imported by core/call.ts for the tool loop. Unused on the structured path,
    // but a module mock must cover every named import or the import itself fails.
    stepCountIs: () => () => false,
    // Reached through the plugin barrel: core/resolve.ts registers every provider
    // plugin, and the local adapters pull in the embedding/transcription/speech
    // adapters, which import these. None of them run on this path.
    embed: () => {
        throw new Error("embed should not be called by callLLMStructured");
    },
    embedMany: () => {
        throw new Error("embedMany should not be called by callLLMStructured");
    },
    transcribe: () => {
        throw new Error("transcribe should not be called by callLLMStructured");
    },
    generateImage: () => {
        throw new Error("generateImage should not be called by callLLMStructured");
    },
}));

const fakeProviderChoice = {
    provider: { name: "fakeprov", type: "openai", provider: "openai", systemPromptPrefix: undefined },
    model: { id: "fake-model" },
} as unknown as Parameters<typeof import("@genesiscz/utils/ai/core/call").callLLMStructured>[0]["providerChoice"];

mock.module("@genesiscz/utils/ask/types/provider", () => ({
    getLanguageModel: () => "MOCK_MODEL",
}));

mock.module("@genesiscz/utils/ai/prompt-caching", () => ({
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
        const { callLLMStructured } = await import("@genesiscz/utils/ai/core/call");
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
        const { callLLMStructured } = await import("@genesiscz/utils/ai/core/call");
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
        const { callLLMStructured } = await import("@genesiscz/utils/ai/core/call");
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
        const { callLLMStructured } = await import("@genesiscz/utils/ai/core/call");
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

    it("falls back to generateObject when the stream errors during iteration before the first chunk", async () => {
        const { callLLMStructured } = await import("@genesiscz/utils/ai/core/call");
        async function* emptyFailingStream(): AsyncGenerator<unknown> {
            throw new Error("stream failed before first chunk");
            // biome-ignore lint/correctness/noUnreachable: generator shape needs a yield
            yield undefined;
        }
        streamObjectMock.mockReturnValueOnce({
            partialObjectStream: emptyFailingStream(),
            object: Promise.reject(new Error("unused")).catch(() => undefined),
            usage: Promise.resolve(undefined),
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
        const { callLLMStructured } = await import("@genesiscz/utils/ai/core/call");
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
