import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { generateText } from "ai";
import type { AccountEntry } from "../../config/schema";
import { openRouterPlugin } from "./openrouter";

/**
 * The outbound request body is the contract. Everything OpenRouter routing does
 * happens there, so the fake `fetch` captures it and the assertions read it back
 * rather than inspecting the SDK's internals.
 */

interface CapturedRequest {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
}

function account(overrides?: Record<string, unknown>): AccountEntry {
    return {
        id: "acc_or_test",
        name: "openrouter",
        provider: "openrouter",
        enabled: true,
        billing: { mode: "metered" },
        credentials: { apiKey: "sk-or-test" },
        useEnvApiKey: false,
        ...(overrides ? { overrides } : {}),
    };
}

const CHAT_RESPONSE = {
    id: "gen-1",
    provider: "Morph",
    model: "anthropic/claude-sonnet-5",
    object: "chat.completion",
    created: 1,
    choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9, cost: 0.000123 },
};

function capturingFetch(captured: CapturedRequest[]): typeof globalThis.fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.push({
            url: String(input),
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            body: SafeJSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });

        return new Response(SafeJSON.stringify(CHAT_RESPONSE), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    }) as unknown as typeof fetch;
}

beforeEach(() => {
    // The credential comes off the account, never off the ambient environment.
    env.testing.unset("OPENROUTER_API_KEY");
});

afterEach(() => {
    env.testing.unset("OPENROUTER_API_KEY");
});

describe("the openrouter plugin", () => {
    test("declares the capabilities and credential every api-key plugin must", () => {
        expect(openRouterPlugin.id).toBe("openrouter");
        expect(openRouterPlugin.kind).toBe("api-key");
        expect([...openRouterPlugin.capabilities].sort()).toEqual([
            "chat",
            "embed",
            "image",
            "summarize",
            "transcribe",
            "translate",
        ]);
        expect(openRouterPlugin.credential.envKeys).toEqual(["OPENROUTER_API_KEY"]);
        expect(openRouterPlugin.credential.required).toContain("apiKey");
    });

    /**
     * `usage.cost` is not free: the SDK sends `include_usage` only in `strict`
     * compatibility mode or when `usage.include` is true, and `createOpenRouter`
     * defaults to `compatible`. Without this the precise-cost path is dead.
     */
    test("asks for usage accounting on every request", async () => {
        const captured: CapturedRequest[] = [];
        const binding = await openRouterPlugin.bind({ account: account(), fetch: capturingFetch(captured) });

        await generateText({ model: binding.language("anthropic/claude-sonnet-5"), prompt: "ping" });

        expect(captured).toHaveLength(1);
        expect(captured[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
        expect(captured[0].body.usage).toEqual({ include: true });
        expect(captured[0].body.model).toBe("anthropic/claude-sonnet-5");
    });

    /**
     * The load-bearing use case: pin a model to named upstreams so it can never
     * silently route elsewhere. `ignore` alone cannot express this, because
     * ignoring the providers you know about still routes to the ones you do not.
     */
    test("account provider pinning reaches the request body verbatim", async () => {
        const captured: CapturedRequest[] = [];
        const binding = await openRouterPlugin.bind({
            account: account({
                openrouter: {
                    provider: { order: ["Morph", "DeepInfra"], allow_fallbacks: false, sort: "throughput" },
                    models: ["moonshotai/kimi-k3", "qwen/qwen3.7-flash"],
                },
            }),
            fetch: capturingFetch(captured),
        });

        await generateText({ model: binding.language("moonshotai/kimi-k3"), prompt: "ping" });

        expect(captured[0].body.provider).toEqual({
            order: ["Morph", "DeepInfra"],
            allow_fallbacks: false,
            sort: "throughput",
        });
        expect(captured[0].body.models).toEqual(["moonshotai/kimi-k3", "qwen/qwen3.7-flash"]);
    });

    test("extraBody and reasoning overrides ride along", async () => {
        const captured: CapturedRequest[] = [];
        const binding = await openRouterPlugin.bind({
            account: account({
                openrouter: {
                    reasoning: { effort: "low", exclude: true },
                    extraBody: { transforms: ["middle-out"] },
                },
            }),
            fetch: capturingFetch(captured),
        });

        await generateText({ model: binding.language("anthropic/claude-sonnet-5"), prompt: "ping" });

        expect(captured[0].body.reasoning).toEqual({ effort: "low", exclude: true });
        expect(captured[0].body.transforms).toEqual(["middle-out"]);
    });

    /** OpenRouter requires one of `max_tokens` / `effort`; a block with neither is not sent. */
    test("an incomplete reasoning block is dropped rather than sent half-formed", async () => {
        const captured: CapturedRequest[] = [];
        const binding = await openRouterPlugin.bind({
            account: account({ openrouter: { reasoning: { enabled: true } } }),
            fetch: capturingFetch(captured),
        });

        await generateText({ model: binding.language("anthropic/claude-sonnet-5"), prompt: "ping" });

        expect(captured[0].body.reasoning).toBeUndefined();
    });

    /** A malformed hint must not stop the account from making calls. */
    test("invalid routing overrides are ignored, not thrown", async () => {
        const captured: CapturedRequest[] = [];
        const binding = await openRouterPlugin.bind({
            account: account({ openrouter: { provider: { order: "Morph" } } }),
            fetch: capturingFetch(captured),
        });

        await generateText({ model: binding.language("anthropic/claude-sonnet-5"), prompt: "ping" });

        expect(captured[0].body.provider).toBeUndefined();
        expect(captured[0].body.usage).toEqual({ include: true });
    });

    test("account.endpoint overrides the base URL", async () => {
        const captured: CapturedRequest[] = [];
        const binding = await openRouterPlugin.bind({
            account: { ...account(), endpoint: "https://gateway.example/api/v1" },
            fetch: capturingFetch(captured),
        });

        await generateText({ model: binding.language("anthropic/claude-sonnet-5"), prompt: "ping" });

        expect(captured[0].url).toBe("https://gateway.example/api/v1/chat/completions");
    });

    test("attribution headers name this app", async () => {
        const captured: CapturedRequest[] = [];
        const binding = await openRouterPlugin.bind({ account: account(), fetch: capturingFetch(captured) });

        await generateText({ model: binding.language("anthropic/claude-sonnet-5"), prompt: "ping" });

        expect(captured[0].headers["x-openrouter-title"]).toBe("GenesisTools");
        expect(captured[0].headers["http-referer"]).toBeString();
    });

    /**
     * 🛑 This pins the Whisper language-hint mapping. `transcription/sdk-result.ts`
     * keys those hints under `"openai"`, which is only correct because
     * `OpenRouterProvider` has no `transcriptionModel` and the plugin therefore
     * builds a second `@ai-sdk/openai` instance for it. If a future change makes
     * transcription come from the OpenRouter SDK, this assertion fails and the
     * hint mapping gets revisited instead of silently going dead.
     */
    test("chat reports provider openrouter while transcription reports openai", async () => {
        const binding = await openRouterPlugin.bind({ account: account(), fetch: capturingFetch([]) });
        const language = binding.language("anthropic/claude-sonnet-5");
        const transcription = binding.transcription?.("openai/whisper-1");

        expect(binding.providerId).toBe("openrouter");
        expect((language as { provider: string }).provider).toStartWith("openrouter");
        expect((transcription as { provider: string } | undefined)?.provider).toStartWith("openai");
    });

    test("exposes an image and an embedding model", async () => {
        const binding = await openRouterPlugin.bind({ account: account(), fetch: capturingFetch([]) });

        expect(binding.image?.("google/gemini-3.1-flash-lite-image")).toBeDefined();
        expect(binding.embedding?.("openai/text-embedding-3-small")).toBeDefined();
        expect(binding.billed).toBe(true);
    });
});
