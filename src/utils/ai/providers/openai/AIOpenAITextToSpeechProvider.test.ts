import { describe, expect, test } from "bun:test";
import { AIOpenAITextToSpeechProvider } from "./AIOpenAITextToSpeechProvider";

describe("AIOpenAITextToSpeechProvider", () => {
    test("has correct type", () => {
        const p = new AIOpenAITextToSpeechProvider();
        expect(p.type).toBe("openai");
    });

    test("supports tts only", () => {
        const p = new AIOpenAITextToSpeechProvider();
        expect(p.supports("tts")).toBe(true);
        expect(p.supports("transcribe")).toBe(false);
    });

    test("isAvailable reflects OPENAI_API_KEY", async () => {
        const p = new AIOpenAITextToSpeechProvider();
        expect(await p.isAvailable()).toBe(!!process.env.OPENAI_API_KEY);
    });

    test("synthesize rejects text over 4096 chars", async () => {
        const p = new AIOpenAITextToSpeechProvider();
        const longText = "a".repeat(4097);
        await expect(p.synthesize(longText)).rejects.toThrow(/4096-character/);
    });

    test("listVoices() returns tts-1 voices by default", async () => {
        const p = new AIOpenAITextToSpeechProvider();
        const voices = await p.listVoices();
        const ids = voices.map((v) => v.id);
        expect(ids).toContain("alloy");
        expect(ids).toContain("nova");
    });

    test("listVoices({ model: 'gpt-4o-mini-tts' }) includes additional voices", async () => {
        const p = new AIOpenAITextToSpeechProvider();
        const voices = await p.listVoices({ model: "gpt-4o-mini-tts" });
        const ids = voices.map((v) => v.id);
        expect(ids).toContain("alloy");
        expect(ids).toContain("ash");
        expect(ids).toContain("verse");
    });

    // Live integration test — short utterance round-trip.
    test.skipIf(!process.env.OPENAI_API_KEY)(
        "synthesize() returns audio bytes for a short utterance (requires OPENAI_API_KEY)",
        async () => {
            const p = new AIOpenAITextToSpeechProvider();
            const result = await p.synthesize("Test", { voice: "alloy", format: "mp3" });
            expect(result.audio.length).toBeGreaterThan(100);
            expect(result.contentType).toMatch(/audio/);
        }
    );
});
