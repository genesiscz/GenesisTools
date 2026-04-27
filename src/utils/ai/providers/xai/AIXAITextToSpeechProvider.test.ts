import { describe, expect, test } from "bun:test";
import { AIXAITextToSpeechProvider } from "./AIXAITextToSpeechProvider";

describe("AIXAITextToSpeechProvider", () => {
    test("has correct type", () => {
        const provider = new AIXAITextToSpeechProvider();
        expect(provider.type).toBe("xai");
    });

    test("supports tts only", () => {
        const provider = new AIXAITextToSpeechProvider();
        expect(provider.supports("tts")).toBe(true);
        expect(provider.supports("transcribe")).toBe(false);
        expect(provider.supports("translate")).toBe(false);
        expect(provider.supports("summarize")).toBe(false);
        expect(provider.supports("embed")).toBe(false);
    });

    test("isAvailable reflects X_AI_API_KEY", async () => {
        const provider = new AIXAITextToSpeechProvider();
        const available = await provider.isAvailable();
        expect(available).toBe(!!process.env.X_AI_API_KEY);
    });

    test("synthesize() rejects text over 15k chars", async () => {
        const provider = new AIXAITextToSpeechProvider();
        const longText = "a".repeat(15_001);

        await expect(provider.synthesize(longText)).rejects.toThrow(/15000-character/);
    });

    // Live integration: hits the real xAI voices endpoint when X_AI_API_KEY is set.
    // Uses forceFreshVoices: true to bypass the 7-day Storage cache.
    test.skipIf(!process.env.X_AI_API_KEY)(
        "listVoices() returns voices from real /v1/tts/voices endpoint (requires X_AI_API_KEY)",
        async () => {
            const provider = new AIXAITextToSpeechProvider({ forceFreshVoices: true });
            const voices = await provider.listVoices();

            expect(voices.length).toBeGreaterThan(0);
            // xAI documents these voice ids; at least one should be present.
            const ids = voices.map((v) => v.id.toLowerCase());
            const knownVoices = ["eve", "ara", "rex", "sal", "leo"];
            const overlap = knownVoices.filter((id) => ids.includes(id));
            expect(overlap.length).toBeGreaterThan(0);

            for (const voice of voices) {
                expect(typeof voice.id).toBe("string");
                expect(voice.id.length).toBeGreaterThan(0);
                expect(typeof voice.name).toBe("string");
            }
        }
    );

    test.skipIf(!process.env.X_AI_API_KEY)("listVoices() second call hits cache (requires X_AI_API_KEY)", async () => {
        // First call (cached, possibly fresh) — just to seed the cache.
        const seed = new AIXAITextToSpeechProvider();
        await seed.listVoices();

        // Stub fetch — if the cache is honored, fetch should NOT be called.
        const originalFetch = globalThis.fetch;
        let fetchCalled = false;
        // @ts-expect-error -- fetch stub for test
        globalThis.fetch = async (...args) => {
            fetchCalled = true;
            return originalFetch(...args);
        };

        try {
            const cached = new AIXAITextToSpeechProvider();
            const voices = await cached.listVoices();
            expect(voices.length).toBeGreaterThan(0);
            expect(fetchCalled).toBe(false);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
