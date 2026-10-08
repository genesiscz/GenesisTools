import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { toLanguageModelUsage } from "@genesiscz/utils/ask/usage-tokens";
import { SafeJSON } from "@genesiscz/utils/json";
import { z } from "zod";

const generateObjectMock = mock();
const streamObjectMock = mock();
const resolveModelMock = mock();
const recordUsageMock = mock(async (..._args: unknown[]) => undefined);

mock.module("@genesiscz/utils/ai/core/resolve", () => ({
    resolveModel: (...args: unknown[]) => resolveModelMock(...args),
}));

mock.module("@genesiscz/utils/ai/usage", () => ({
    recordUsage: (...args: unknown[]) => recordUsageMock(...args),
}));

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
    resolveModelMock.mockReset();
    recordUsageMock.mockClear();
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
        expect(recordUsageMock).toHaveBeenCalledTimes(1);
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
        expect(recordUsageMock).toHaveBeenCalledTimes(1);
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

describe("structured cancellation and binding lifetime", () => {
    const schema = z.object({ tldr: z.string() });
    const options = { systemPrompt: "x", userPrompt: "y", schema, providerChoice: fakeProviderChoice };

    it("rejects a pre-aborted call before resolving credentials or invoking the SDK", async () => {
        const { callLLMStructured } = await import("@genesiscz/utils/ai/core/call");
        const controller = new AbortController();
        controller.abort(new Error("cancelled before start"));

        await expect(
            callLLMStructured({
                ...options,
                providerChoice: undefined,
                model: "fake-model",
                abortSignal: controller.signal,
            })
        ).rejects.toThrow("cancelled before start");
        expect(resolveModelMock).not.toHaveBeenCalled();
        expect(generateObjectMock).not.toHaveBeenCalled();
        expect(streamObjectMock).not.toHaveBeenCalled();
    });

    it("passes the same signal through ordinary streaming fallback", async () => {
        const { callLLMStructured } = await import("@genesiscz/utils/ai/core/call");
        const controller = new AbortController();
        streamObjectMock.mockImplementationOnce(() => {
            throw new Error("stream unavailable");
        });
        generateObjectMock.mockResolvedValueOnce({ object: { tldr: "fallback" } });

        await callLLMStructured({ ...options, abortSignal: controller.signal, onPartial: () => {} });

        expect(streamObjectMock.mock.calls[0][0].abortSignal).toBe(controller.signal);
        expect(generateObjectMock.mock.calls[0][0].abortSignal).toBe(controller.signal);
    });

    it("never falls back after cancellation before the first chunk", async () => {
        const { callLLMStructured } = await import("@genesiscz/utils/ai/core/call");
        const controller = new AbortController();
        streamObjectMock.mockImplementationOnce(() => {
            controller.abort(new Error("stop request"));
            throw new Error("transport closed");
        });

        await expect(
            callLLMStructured({
                ...options,
                abortSignal: controller.signal,
                onPartial: () => {},
            })
        ).rejects.toThrow("stop request");
        expect(generateObjectMock).not.toHaveBeenCalled();
    });

    it("does not restart an SDK AbortError even without a caller signal", async () => {
        const { callLLMStructured } = await import("@genesiscz/utils/ai/core/call");
        streamObjectMock.mockImplementationOnce(() => {
            throw new DOMException("SDK cancelled", "AbortError");
        });

        await expect(callLLMStructured({ ...options, onPartial: () => {} })).rejects.toThrow("SDK cancelled");
        expect(generateObjectMock).not.toHaveBeenCalled();
    });

    it("stops partial delivery when a callback cancels and does not return a final object", async () => {
        const { callLLMStructured } = await import("@genesiscz/utils/ai/core/call");
        const controller = new AbortController();
        streamObjectMock.mockReturnValueOnce({
            partialObjectStream: partialsOf({ tldr: "first" }, { tldr: "second" }),
            object: Promise.resolve({ tldr: "finished" }),
            usage: Promise.resolve(undefined),
        });
        const seen: unknown[] = [];

        await expect(
            callLLMStructured({
                ...options,
                abortSignal: controller.signal,
                onPartial: (value) => {
                    seen.push(value);
                    controller.abort(new Error("cancel after partial"));
                },
            })
        ).rejects.toThrow("cancel after partial");
        expect(seen).toEqual([{ tldr: "first" }]);
        expect(generateObjectMock).not.toHaveBeenCalled();
    });

    it("records already-reported spend before discarding a cancelled completed response", async () => {
        const { callLLMStructured } = await import("@genesiscz/utils/ai/core/call");
        const controller = new AbortController();
        generateObjectMock.mockImplementationOnce(async () => {
            controller.abort(new Error("cancelled result"));
            return {
                object: { tldr: "late" },
                usage: toLanguageModelUsage({ inputTokens: 10, outputTokens: 5 }),
            };
        });

        await expect(
            callLLMStructured({
                ...options,
                abortSignal: controller.signal,
            })
        ).rejects.toThrow("cancelled result");
        expect(recordUsageMock).toHaveBeenCalledTimes(1);
    });

    for (const outcome of ["success", "error", "abort", "resolution-abort"] as const) {
        it(`disposes its own binding on ${outcome}`, async () => {
            const { callLLMStructured } = await import("@genesiscz/utils/ai/core/call");
            const controller = new AbortController();
            const dispose = mock(() => {});
            resolveModelMock.mockImplementationOnce(async () => {
                if (outcome === "resolution-abort") {
                    controller.abort(new Error("resolution cancelled"));
                }

                return {
                    account: { id: "acc_work", name: "work", provider: "openai" },
                    plugin: { id: "openai" },
                    model: { id: "fake-model" },
                    binding: { language: () => "MOCK_MODEL", dispose },
                };
            });
            generateObjectMock.mockImplementationOnce(async () => {
                if (outcome === "error") {
                    throw new Error("failed generation");
                }

                if (outcome === "abort") {
                    controller.abort(new Error("generation cancelled"));
                }

                return { object: { tldr: "done" } };
            });
            const pending = callLLMStructured({
                ...options,
                providerChoice: undefined,
                model: "fake-model",
                abortSignal: controller.signal,
            });

            if (outcome === "success") {
                expect((await pending).object).toEqual({ tldr: "done" });
            } else {
                await expect(pending).rejects.toThrow();
            }

            expect(dispose).toHaveBeenCalledTimes(1);

            if (outcome === "resolution-abort") {
                expect(generateObjectMock).not.toHaveBeenCalled();
            }
        });
    }

    it("leaves a supplied binding reusable after failure", async () => {
        const { callLLMStructured } = await import("@genesiscz/utils/ai/core/call");
        const dispose = mock(() => {});
        const supplied = {
            account: { id: "acc_work", name: "work", provider: "openai" },
            plugin: { id: "openai" },
            model: { id: "fake-model" },
            binding: { language: () => "MOCK_MODEL", dispose },
        } as unknown as import("@genesiscz/utils/ai/core/types").ResolvedBinding;
        generateObjectMock.mockRejectedValueOnce(new Error("failed"));
        const suppliedOptions = { ...options, providerChoice: undefined, model: supplied };

        await expect(callLLMStructured(suppliedOptions)).rejects.toThrow("failed");
        generateObjectMock.mockResolvedValueOnce({ object: { tldr: "second call" } });
        expect((await callLLMStructured(suppliedOptions)).object.tldr).toBe("second call");
        expect(dispose).not.toHaveBeenCalled();
        expect(resolveModelMock).not.toHaveBeenCalled();
    });
});
