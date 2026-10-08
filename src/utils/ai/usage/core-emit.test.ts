import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import type { LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { type CallTarget, callLLMStructured, coreChat } from "../core/call";
import type { ResolvedBinding } from "../core/types";
import { usageDir } from "./paths";
import { queryUsage } from "./query";

/**
 * The wiring between `coreChat` and the usage layer, exercised end to end.
 *
 * It lives beside the layer rather than beside `core/call.ts` because what is
 * under test is the emission contract — a row lands, and a broken store cannot
 * take a chat down with it.
 */

let home: string;

// `@ai-sdk/provider` is a transitive package here, so the result shape is taken
// from the mock's own constructor rather than imported across the boundary.
// It also gives `finishReason` a contextual type instead of widening to string.
type MockConfig = NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>;
type GenerateFn = Extract<MockConfig["doGenerate"], (options: never) => unknown>;
type GenerateResult = Awaited<ReturnType<GenerateFn>>;

const STOP: GenerateResult["finishReason"] = { unified: "stop", raw: "stop" };

function mockModel(usage: { input: number | undefined; output: number | undefined }): LanguageModel {
    const config: MockConfig = {
        doGenerate: async (): Promise<GenerateResult> => ({
            content: [{ type: "text", text: "hello" }],
            finishReason: STOP,
            // Every token field must be PRESENT, `undefined` included.
            usage: {
                inputTokens: { total: usage.input, noCache: usage.input, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: usage.output, text: usage.output, reasoning: undefined },
            },
            warnings: [],
        }),
    };

    return new MockLanguageModelV4(config) as unknown as LanguageModel;
}

function target(overrides: Partial<CallTarget> = {}): CallTarget {
    return {
        model: mockModel({ input: 120, output: 30 }),
        providerType: "anthropic",
        label: "martin-max/claude-opus-4-1-20250805",
        accountId: "acc_max",
        provider: "anthropic",
        modelId: "claude-opus-4-1-20250805",
        app: "ask",
        ...overrides,
    };
}

function todayWindow(): { from: string; to: string } {
    const now = Date.now();

    return {
        from: new Date(now - 60_000).toISOString(),
        to: new Date(now + 60_000).toISOString(),
    };
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-core-emit-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
});

describe("coreChat → recordUsage", () => {
    test("records one row per call, attributed to the target's account and model", async () => {
        const result = await coreChat({ target: target(), prompt: "hi" });

        expect(result.content).toBe("hello");

        const events = queryUsage(todayWindow()).events;

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            app: "ask",
            accountId: "acc_max",
            provider: "anthropic",
            modelId: "claude-opus-4-1-20250805",
            inputTokens: 120,
            outputTokens: 30,
        });
    });

    test("prices the row from the catalog", async () => {
        // claude-opus-4-1: $15/1M in, $75/1M out.
        await coreChat({ target: target({ model: mockModel({ input: 1_000_000, output: 0 }) }), prompt: "hi" });

        expect(queryUsage(todayWindow()).total.costUsd).toBe(15);
    });

    test("falls back to `unknown` rather than dropping a row when the target names no account", async () => {
        await coreChat({
            target: target({ accountId: undefined, provider: undefined, app: undefined }),
            prompt: "hi",
        });

        const events = queryUsage(todayWindow()).events;

        expect(events).toHaveLength(1);
        expect(events[0].accountId).toBe("unknown");
        expect(events[0].app).toBe("ai-core");
        expect(events[0].provider).toBe("anthropic");
    });

    test("an unwritable usage store does not break the call", async () => {
        // Occupy the usage dir's path with a file: mkdir and append both fail.
        mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
        writeFileSync(usageDir(), "not a directory");

        const result = await coreChat({ target: target(), prompt: "hi" });

        expect(result.content).toBe("hello");
        expect(result.usage?.inputTokens).toBe(120);
    });

    test("does not bill cached input twice, and keeps the cache counts in meta", async () => {
        // ai@7's Anthropic provider reports total inputTokens INCLUDING cache.
        // 1M total = 200k fresh + 600k cache-read + 200k cache-write.
        const model = new MockLanguageModelV4({
            doGenerate: async (): Promise<GenerateResult> => ({
                content: [{ type: "text", text: "hello" }],
                finishReason: STOP,
                usage: {
                    inputTokens: {
                        total: 1_000_000,
                        noCache: 200_000,
                        cacheRead: 600_000,
                        cacheWrite: 200_000,
                    },
                    outputTokens: { total: 0, text: 0, reasoning: undefined },
                },
                warnings: [],
            }),
        }) as unknown as LanguageModel;

        await coreChat({ target: target({ model }), prompt: "hi" });

        const events = queryUsage(todayWindow()).events;

        // Billable input is the 200k fresh tokens, NOT the 1M total.
        expect(events[0].inputTokens).toBe(200_000);
        expect(events[0].meta).toMatchObject({ cacheReadTokens: 600_000, cacheWriteTokens: 200_000 });

        // claude-opus-4-1: $15/1M in, $1.50/1M cache read, $18.75/1M cache write.
        // 0.2*15 + 0.6*1.5 + 0.2*18.75 = 3 + 0.9 + 3.75 = 7.65.
        // Billing the raw 1M total at the input rate would have said $15+.
        expect(events[0].costUsd).toBeCloseTo(7.65, 6);
    });

    test("records nothing when the provider reported no usage", async () => {
        await coreChat({
            target: target({ model: mockModel({ input: undefined, output: undefined }) }),
            prompt: "hi",
        });

        expect(queryUsage(todayWindow()).total.events).toBe(0);
    });
});

describe("callLLMStructured → recordUsage", () => {
    function structuredBinding(config: { missingUsage?: boolean; onGenerate?: () => void } = {}): ResolvedBinding {
        const model = new MockLanguageModelV4({
            doGenerate: async (): Promise<GenerateResult> => {
                config.onGenerate?.();

                return {
                    content: [{ type: "text", text: '{"answer":"review me"}' }],
                    finishReason: STOP,
                    usage: {
                        inputTokens: {
                            total: config.missingUsage ? undefined : 100,
                            noCache: config.missingUsage ? undefined : 25,
                            cacheRead: config.missingUsage ? undefined : 60,
                            cacheWrite: config.missingUsage ? undefined : 15,
                        },
                        outputTokens: {
                            total: config.missingUsage ? undefined : 5,
                            text: config.missingUsage ? undefined : 5,
                            reasoning: undefined,
                        },
                    },
                    providerMetadata: { openrouter: { usage: { cost: 0.0123 } } },
                    warnings: [],
                };
            },
        }) as unknown as LanguageModel;

        return {
            account: { id: "acc_personal", name: "personal", provider: "openrouter" },
            plugin: { id: "openrouter" },
            model: { id: "fake-model" },
            binding: { language: () => model },
        } as unknown as ResolvedBinding;
    }

    const structuredOptions = {
        systemPrompt: "Return a reviewable proposal.",
        userPrompt: "A bounded test.",
        schema: z.object({ answer: z.string() }),
        app: "model-room",
    };

    test("attributes one structured event with cache counts and provider-reported cost", async () => {
        const result = await callLLMStructured({ ...structuredOptions, model: structuredBinding() });

        expect(result.object.answer).toBe("review me");
        const events = queryUsage(todayWindow()).events;
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            app: "model-room",
            accountId: "acc_personal",
            provider: "openrouter",
            modelId: "fake-model",
            inputTokens: 25,
            outputTokens: 5,
            costUsd: 0.0123,
            costSource: "supplied",
            meta: { cacheReadTokens: 60, cacheWriteTokens: 15 },
        });
    });

    test("does not invent a zero-usage event when structured usage is absent", async () => {
        await callLLMStructured({
            ...structuredOptions,
            model: structuredBinding({ missingUsage: true }),
        });

        expect(queryUsage(todayWindow()).total.events).toBe(0);
    });

    test("returns the structured result even if usage storage is unwritable", async () => {
        mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
        writeFileSync(usageDir(), "not a directory");

        const result = await callLLMStructured({ ...structuredOptions, model: structuredBinding() });

        expect(result.object.answer).toBe("review me");
        expect(result.usage?.outputTokens).toBe(5);
    });

    test("keeps completed spend when cancellation discards the proposal", async () => {
        const controller = new AbortController();

        await expect(
            callLLMStructured({
                ...structuredOptions,
                model: structuredBinding({
                    onGenerate: () => controller.abort(new Error("proposal cancelled")),
                }),
                abortSignal: controller.signal,
            })
        ).rejects.toThrow("proposal cancelled");
        expect(queryUsage(todayWindow()).events).toHaveLength(1);
    });
});
